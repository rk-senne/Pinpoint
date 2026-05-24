/**
 * API client for the Pinpoint Extension.
 *
 * Defines the single `API_BASE` constant used for every API request issued
 * by the extension and exposes thin fetch wrappers that prepend it
 * (Requirement 25.4, design decision 10).
 *
 * Sliding-window JWT refresh (Requirement 33.4, task 24.4)
 * --------------------------------------------------------
 * Every authenticated fetch first inspects the stored Bearer_Token's `exp`
 * claim. When the token is within 5 minutes (`REFRESH_THRESHOLD_SECONDS`) of
 * expiry, the client calls `POST /api/v1/auth/refresh` with the current
 * token, replaces the stored token in `chrome.storage.local` on success,
 * and only then issues the original request with the new token.
 *
 * Concurrent calls share a single in-flight refresh promise so the server
 * receives at most one refresh per expiry window even when several
 * requests fire at the same moment (e.g. the overlay rendering on first
 * mount). If `/auth/refresh` itself returns 401 (the token is past the
 * 7-day grace window), we deliberately do **not** loop back into another
 * refresh — the caller's request proceeds with whatever token was in
 * storage and the resulting 401 is handled by the post-response hook
 * below (clear the token, open the popup login surface).
 *
 * 401 cleanup (Requirement 33.5, task 24.5)
 * -----------------------------------------
 * After every wrapped fetch, if the server returned 401 we wipe the
 * stored bearer from `chrome.storage.local` and try to surface the popup
 * login UI. `chrome.action.openPopup()` is only callable from the
 * service worker, so when the wrapper runs from a content script we
 * fall back to dispatching a `pinpoint:auth-required` `CustomEvent`
 * that the overlay can listen for. The 401 `Response` itself is still
 * returned to the caller untouched — callers that want to inspect the
 * envelope (`code`, `message`) can do so. We deliberately skip this
 * cleanup when the wrapped request *is* `/auth/refresh` so a failed
 * refresh does not double-clear (the auto-refresh path in
 * `performRefresh` handles its own failure mode by leaving storage
 * intact and letting the next 401 surface here).
 *
 * Note: this module never *verifies* JWT signatures locally — Manifest V3
 * service workers don't expose Node-style crypto primitives — but signature
 * verification still happens server-side on every request.
 */

import {
  STORAGE_KEY_TOKEN,
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
} from './authTokenStore';

/**
 * Re-export the auth-token helpers from `authTokenStore` for back-compat.
 * Earlier versions of this module defined the key + helpers locally; the
 * canonical implementation now lives in `authTokenStore.ts`. Re-exporting
 * here keeps the existing import paths in callers (`./api`) working.
 */
export {
  STORAGE_KEY_TOKEN,
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
};

/**
 * Single source of truth for the Extension's API URL prefix.
 * All current endpoints live under `/api/v1`.
 */
export const API_BASE = '/api/v1';

/**
 * Default API origin used when no build-time override is configured.
 * Centralised here so `connectionMonitor` and `OverlayHost` import the
 * same constant rather than each redeclaring the literal.
 */
export const DEFAULT_API_ORIGIN = 'http://localhost:3001';

/**
 * Refresh the bearer this many seconds before its `exp` claim. Matches
 * Requirement 33.4 ("within 5 minutes of expiration").
 */
export const REFRESH_THRESHOLD_SECONDS = 300;

/**
 * Server origin used by extension fetches. Content scripts run on arbitrary
 * host pages, so relative URLs are unusable; we resolve the origin from a
 * build-time global when available and fall back to the local dev server.
 *
 * Exported so `connectionMonitor` and `OverlayHost` can share the same
 * resolution logic instead of redeclaring the localhost fallback.
 */
export function resolveServerOrigin(): string {
  const override = (globalThis as { __PINPOINT_API_ORIGIN__?: string })
    .__PINPOINT_API_ORIGIN__;
  if (typeof override === 'string' && override.length > 0) return override;
  return DEFAULT_API_ORIGIN;
}

/**
 * Surface the "please sign in" prompt after the server has rejected our
 * bearer with a 401. We try `chrome.action.openPopup()` first because
 * that's the cleanest UX — the popup login form opens in-browser — but
 * that API is only callable from the service worker. Content scripts
 * fall through to dispatching a `pinpoint:auth-required`
 * `CustomEvent` so the overlay can render its own "Sign in" affordance.
 *
 * Both paths are wrapped in try/catch: `openPopup` throws when called
 * from a non-service-worker context, and `dispatchEvent` is unavailable
 * in service workers (no `window`). Failing silently here is the right
 * call — the original 401 `Response` still propagates to the caller,
 * and the caller can decide whether to show its own message.
 */
function surfaceAuthRequiredPrompt(): void {
  // Try the service-worker-only `chrome.action.openPopup()` first.
  try {
    const action = (
      typeof chrome !== 'undefined'
        ? (chrome as { action?: { openPopup?: () => unknown } }).action
        : undefined
    );
    if (action && typeof action.openPopup === 'function') {
      // Some Chrome versions return a promise, others void. Either way,
      // swallow rejections — we still dispatch the event below as a
      // belt-and-braces signal that something is listening for.
      const result = action.openPopup() as unknown;
      if (
        result &&
        typeof (result as Promise<unknown>).then === 'function'
      ) {
        (result as Promise<unknown>).catch(() => {
          /* ignore — fall through to event dispatch below */
        });
      }
      return;
    }
  } catch {
    /* fall through to event dispatch */
  }

  // Content-script / overlay fallback: dispatch a CustomEvent so the
  // overlay can render its own "Sign in" prompt.
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent !== 'undefined'
    ) {
      window.dispatchEvent(new CustomEvent('pinpoint:auth-required'));
    }
  } catch {
    /* nothing else we can do here */
  }
}

/**
 * Best-effort base64url decode that handles the `-`/`_` alphabet and
 * missing `=` padding used by JWTs. Falls back to raw `atob` for tokens
 * that already use the standard alphabet. Returns `null` on any decoding
 * error so the caller can degrade gracefully (e.g. skip the refresh).
 */
function base64UrlDecode(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    if (typeof atob === 'function') {
      return atob(padded);
    }
    // Manifest-V3 service workers expose `atob` globally, but fall back
    // to `Buffer` for jsdom-less Node environments (vitest unit tests
    // import this module under `node` env in some specs).
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('binary');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT and return its `exp` claim (seconds since epoch), or
 * `null` if the token is malformed, the payload is not JSON, or the
 * `exp` claim is missing/non-numeric.
 *
 * **No signature verification is performed.** This helper exists solely
 * so the client can decide whether to refresh proactively; the server
 * is the only authority on token validity.
 */
export function decodeJwtExp(token: string): number | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payloadJson = base64UrlDecode(parts[1]);
  if (payloadJson === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('exp' in payload)
  ) {
    return null;
  }
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp;
}

/**
 * Returns true when the supplied token is within
 * `REFRESH_THRESHOLD_SECONDS` of its `exp` claim (or already expired).
 * Tokens that fail to decode (no `exp`, malformed) are treated as
 * "do not refresh" — the server will reject them on the next call,
 * triggering the 401-clears-token path.
 */
export function shouldRefreshToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return false;
  return exp - nowSeconds < REFRESH_THRESHOLD_SECONDS;
}

interface RefreshResponse {
  token: string;
}

/**
 * In-flight refresh promise. Concurrent callers that all observe a
 * near-expiry token share this single promise so `/auth/refresh` is
 * called at most once per expiry window. Cleared as soon as the call
 * settles (success or failure).
 */
let inflightRefresh: Promise<string | null> | null = null;

/**
 * Test-only hook to reset the shared in-flight refresh. Production code
 * never needs this; it exists so vitest specs can isolate cases.
 */
export function __resetInflightRefreshForTests(): void {
  inflightRefresh = null;
}

/**
 * POST `/api/v1/auth/refresh` with the supplied token in `Authorization`.
 * On success, stores the freshly minted token in `chrome.storage.local`
 * and returns it. On any non-2xx status (including 401 past-grace) or
 * network error, returns `null` and leaves storage untouched — callers
 * fall back to the original token and let the resulting request 401
 * trigger task 24.5's clear-and-prompt path.
 */
async function performRefresh(currentToken: string): Promise<string | null> {
  try {
    const url = `${resolveServerOrigin()}${API_BASE}/auth/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      body: '{}',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | RefreshResponse
      | null;
    const fresh = body?.token;
    if (typeof fresh !== 'string' || fresh.length === 0) return null;
    await setStoredAuthToken(fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Coalesce concurrent refreshes onto a single in-flight promise. The
 * first caller observes `inflightRefresh === null`, kicks off the
 * network call, and stashes the promise; subsequent callers await the
 * same promise. The promise is cleared in a `finally` so the next
 * expiry-window observation starts a brand new refresh.
 */
async function refreshTokenIfNeeded(token: string): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  const promise = performRefresh(token).finally(() => {
    if (inflightRefresh === promise) inflightRefresh = null;
  });
  inflightRefresh = promise;
  return promise;
}

/**
 * Resolve the bearer to use for the next API call: refresh first if the
 * stored token is within the 5-minute window, otherwise return it
 * unchanged. Returns `null` when the user is signed out so callers omit
 * the `Authorization` header entirely (matches the legacy behaviour).
 */
async function resolveAuthTokenForRequest(): Promise<string | null> {
  const stored = await getStoredAuthToken();
  if (stored === null) return null;
  if (!shouldRefreshToken(stored)) return stored;
  const fresh = await refreshTokenIfNeeded(stored);
  return fresh ?? stored;
}

export interface ApiFetchOptions extends RequestInit {
  /** When `true`, skip the JSON `Content-Type`/`Accept` defaults (e.g. for `multipart/form-data` uploads). */
  raw?: boolean;
}

/**
 * Issue an authenticated request to `${API_BASE}${path}` and return the raw `Response`.
 * Use this when the caller needs to inspect status, headers, or non-JSON bodies
 * (e.g. screenshot uploads in task 25.x).
 *
 * Before issuing the request, the wrapper inspects the stored bearer's
 * `exp` claim and transparently calls `/auth/refresh` when the token is
 * within `REFRESH_THRESHOLD_SECONDS` of expiry (Requirement 33.4).
 *
 * After the response arrives, a 401 status triggers the auth-cleanup
 * path (Requirement 33.5): the stored bearer is wiped from
 * `chrome.storage.local` and the popup login surface is opened (or a
 * `pinpoint:auth-required` event is dispatched as a fallback for
 * content-script callers). The 401 `Response` itself is returned
 * unchanged so callers can inspect the envelope. The cleanup is skipped
 * when the wrapped request is `/auth/refresh` itself — the
 * sliding-window code already handles that failure mode by leaving
 * storage intact and falling through with the original token, and
 * we don't want a refresh failure to clear storage twice in a row.
 */
export async function apiFetchRaw(
  path: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  const { raw, headers: extraHeaders, ...init } = options;
  const headers: Record<string, string> = {
    ...(raw
      ? {}
      : { 'Content-Type': 'application/json', Accept: 'application/json' }),
    ...((extraHeaders as Record<string, string>) || {}),
  };
  const token = await resolveAuthTokenForRequest();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = `${resolveServerOrigin()}${API_BASE}${path}`;
  const res = await fetch(url, { ...init, headers });

  // Req 33.5: on any 401 from the API, drop the stored bearer and surface
  // the popup login. Skip this when the request *was* the refresh call —
  // refresh failure is handled by `performRefresh` on its own (it leaves
  // storage intact so the next 401 from a real endpoint surfaces here).
  if (res.status === 401 && path !== '/auth/refresh') {
    try {
      await clearStoredAuthToken();
    } catch {
      /* swallow — surfacing the prompt is more important than logging */
    }
    surfaceAuthRequiredPrompt();
  }

  return res;
}

/**
 * Issue an authenticated request to `${API_BASE}${path}` and parse the JSON body.
 * Throws an `Error` whose message comes from the server's error envelope when present.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const res = await apiFetchRaw(path, options);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const envelopeMessage =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
        ? (body as { error: { message: string } }).error.message
        : null;
    throw new Error(
      envelopeMessage || `Request failed with status ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

/* -------------------------------------------------------------------------- */
/* Outbox-first mutating wrappers (task 36.2 — Reqs 44.1, 44.2)               */
/* -------------------------------------------------------------------------- */
/**
 * Every mutating call below funnels through the same four-step pipeline so
 * the Extension can keep working offline (Reqs 44.1, 44.2):
 *
 *   1. Generate a `localUuid` via `crypto.randomUUID()`. This becomes
 *      both the optimistic row's `id` (so the UI renders something
 *      immediately) AND the `clientRequestId` the Syncer will attach
 *      when replaying the request, so the server's idempotency layer
 *      (task 35.2) collapses retries (Req 44.3).
 *   2. Persist a single `OutboxEntry` to `chrome.storage.local` via
 *      `Outbox.enqueue`. The entry is the durable source of truth for
 *      "we promised the user this mutation will reach the server" —
 *      anything past this point is best-effort UI sugar.
 *   3. Optimistically insert the local row into the overlay store. The
 *      caller supplies a strongly-typed optimistic writer because the
 *      overlay store layout differs per call site (jsdom tests pass
 *      `null`; the content script forwards the host's store). The
 *      writer receives the freshly-built row and updates whichever
 *      signal it owns.
 *   4. Wake the Syncer (`triggerSync()`). The Syncer (task 36.3) drains
 *      the outbox immediately when connected; while offline, the next
 *      `online` event or 30 s tick picks the entry up.
 *
 * The wrapper returns the `localUuid` so the caller can correlate the
 * optimistic row, the outbox entry, and the eventual server-assigned id
 * once the Syncer's success path (task 36.4) runs `Outbox.replace`.
 *
 * Read-only (`GET`) calls are unchanged — they still go through
 * `apiFetch`/`apiFetchRaw` directly. Only mutating verbs (annotation
 * create, annotation status change, comment create) need this path.
 *
 * Test seam: every wrapper takes an optional `deps` bag so unit tests can
 * inject in-memory replacements for the Outbox and Syncer modules
 * without bringing in `chrome.storage.local`. Production callers pass
 * nothing and the defaults (`Outbox.enqueue` / `triggerSync`) are used.
 */

import { enqueue as enqueueOutbox, type OutboxEntry } from './Outbox';
import { triggerSync as defaultTriggerSync } from './Syncer';
import type {
  Annotation,
  AnnotationStatus,
  Comment as FLComment,
} from '@pinpoint/shared';

/**
 * Dependency overrides for the queue helpers. Production code uses the
 * defaults (`Outbox.enqueue` and `Syncer.triggerSync`); tests inject
 * fakes so they do not need to stub `chrome.storage.local`.
 */
export interface QueueMutationDeps {
  /** Append an entry to the durable outbox. Defaults to `Outbox.enqueue`. */
  enqueueOutbox?: (entry: OutboxEntry) => Promise<void>;
  /**
   * Wake the Syncer. Defaults to `Syncer.triggerSync`. The return value
   * is intentionally permissive: the production Syncer returns a
   * `Promise<void>` (so callers *can* await the drain in tests) but the
   * mutating-call path never awaits — the durable enqueue has already
   * succeeded, and any drain failure is the Syncer's problem to surface
   * (task 36.5's Sync_Conflict_Tray).
   */
  triggerSync?: () => void | Promise<void>;
  /** Override the UUID generator (tests only). Defaults to `crypto.randomUUID()`. */
  uuid?: () => string;
  /** Override the timestamp generator (tests only). Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Resolve a single dependency bag with defaults applied. Pulled into a
 * helper so every wrapper agrees on the resolution order and so the
 * behaviour can be unit-tested centrally.
 */
function resolveDeps(deps: QueueMutationDeps | undefined): {
  enqueueOutbox: (entry: OutboxEntry) => Promise<void>;
  triggerSync: () => void | Promise<void>;
  uuid: () => string;
  now: () => string;
} {
  return {
    enqueueOutbox: deps?.enqueueOutbox ?? enqueueOutbox,
    triggerSync: deps?.triggerSync ?? defaultTriggerSync,
    uuid:
      deps?.uuid ??
      (() => {
        // `crypto.randomUUID` is available in MV3 service workers and
        // modern jsdom; fall back to a v4 shape built from `getRandomValues`
        // when the host page somehow lacks it.
        if (typeof crypto !== 'undefined') {
          if (typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
          }
          if (typeof crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            // RFC 4122 v4 layout.
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, (b) =>
              b.toString(16).padStart(2, '0'),
            ).join('');
            return (
              `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
              `-${hex.slice(16, 20)}-${hex.slice(20)}`
            );
          }
        }
        // Last-resort, decidedly non-cryptographic fallback.
        return `local-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      }),
    now: deps?.now ?? (() => new Date().toISOString()),
  };
}

/* -------------------------------------------------------------------------- */
/* Annotation create                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Trigger the Syncer in fire-and-forget mode. Wraps the user-supplied
 * (possibly async) trigger so a rejected promise is swallowed instead of
 * surfacing as an unhandled rejection — the durable enqueue is the
 * source of truth for "did this mutation get recorded", and any drain
 * failure is the Syncer's problem (task 36.5's Sync_Conflict_Tray).
 */
function fireAndForgetSync(trigger: () => void | Promise<void>): void {
  try {
    const result = trigger();
    if (
      result &&
      typeof (result as Promise<unknown>).then === 'function'
    ) {
      (result as Promise<unknown>).catch(() => {
        /* swallow — see comment above */
      });
    }
  } catch {
    /* swallow — see comment above */
  }
}

/**
 * Input fields the caller supplies for a queued annotation create. Mirrors
 * the server's `POST /api/v1/projects/:id/annotations` body (task 9.4 +
 * Phase 17 capture buffers + Phase 16 screenshot key) minus the fields
 * the server assigns (`id`, `pinNumber`, `createdAt`, `updatedAt`,
 * `authorId`, `clientRequestId`).
 */
export interface QueueCreateAnnotationInput {
  projectId: string;
  pageId?: string;
  pageUrl?: string;
  type: Annotation['type'];
  severity: Annotation['severity'];
  body: string;
  target: Annotation['target'];
  environment: Annotation['environment'];
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string;
  capturedConsole?: Annotation['capturedConsole'];
  capturedNetwork?: Annotation['capturedNetwork'];
  screenshotObjectKey?: string;
}

/**
 * Optimistic-row writer for annotation creates. Receives the full
 * locally-constructed `Annotation` (including the locally-minted
 * `id = localUuid`, the placeholder `pinNumber: 0`, and the synthetic
 * timestamps) so the caller can splice it into whatever overlay store
 * slice it owns. Returning a value is allowed but ignored.
 */
export type QueueCreateAnnotationOptimisticWriter = (
  annotation: Annotation,
) => void;

/**
 * Result of a queued mutation. Callers can correlate the outbox entry,
 * the optimistic row, and the Syncer's eventual replacement against
 * `localUuid`.
 */
export interface QueueMutationResult {
  /** The locally generated UUID v4. Doubles as `clientRequestId` on replay. */
  localUuid: string;
}

/**
 * Queue an annotation create:
 *   1. Mint a `localUuid`.
 *   2. Build an outbox entry whose payload mirrors the eventual
 *      `POST /projects/:id/annotations` body (with `clientRequestId`
 *      pre-attached so the Syncer just forwards `payload` verbatim).
 *   3. Persist the entry via `Outbox.enqueue`.
 *   4. Build the optimistic local `Annotation` row whose `id` is
 *      `localUuid`. `pinNumber` is `0` because the server is the only
 *      authority for that counter (task 10.1); the Syncer rewrites it
 *      after replay.
 *   5. Hand the optimistic row to the caller's writer so the overlay
 *      store updates immediately.
 *   6. Trigger the Syncer.
 */
export async function queueCreateAnnotation(
  input: QueueCreateAnnotationInput,
  optimistic?: QueueCreateAnnotationOptimisticWriter | null,
  deps?: QueueMutationDeps,
): Promise<QueueMutationResult> {
  const d = resolveDeps(deps);
  const localUuid = d.uuid();
  const createdAt = d.now();

  // The server-bound payload. `clientRequestId` is wired up at enqueue
  // time so the Syncer can forward `entry.payload` to the server unchanged.
  const payload = {
    type: input.type,
    severity: input.severity,
    body: input.body,
    target: input.target,
    pageUrl: input.pageUrl,
    pageId: input.pageId,
    environment: input.environment,
    guidelineId: input.guidelineId,
    assigneeId: input.assigneeId,
    dueDate: input.dueDate,
    capturedConsole: input.capturedConsole,
    capturedNetwork: input.capturedNetwork,
    screenshotObjectKey: input.screenshotObjectKey,
    // The server route lives under `/projects/:id/...` so the Syncer
    // needs the project id; carry it on the payload rather than as a
    // separate field so the entry shape stays uniform.
    projectId: input.projectId,
    clientRequestId: localUuid,
  };

  await d.enqueueOutbox({
    localUuid,
    kind: 'create-annotation',
    payload,
    pendingSync: true,
    createdAt,
  });

  if (optimistic) {
    const optimisticRow: Annotation = {
      id: localUuid,
      projectId: input.projectId,
      pageId: input.pageId ?? '',
      pageUrl: input.pageUrl,
      type: input.type,
      severity: input.severity,
      status: 'active',
      body: input.body,
      authorId: '',
      createdAt,
      updatedAt: createdAt,
      target: input.target,
      environment: input.environment,
      guidelineId: input.guidelineId,
      assigneeId: input.assigneeId,
      dueDate: input.dueDate,
      pinNumber: 0,
      screenshotObjectKey: input.screenshotObjectKey,
      capturedConsole: input.capturedConsole,
      capturedNetwork: input.capturedNetwork,
      clientRequestId: localUuid,
    };
    optimistic(optimisticRow);
  }

  fireAndForgetSync(d.triggerSync);
  return { localUuid };
}

/* -------------------------------------------------------------------------- */
/* Annotation status change                                                   */
/* -------------------------------------------------------------------------- */

/** Input for a queued status change. */
export interface QueueChangeAnnotationStatusInput {
  annotationId: string;
  status: AnnotationStatus;
}

/**
 * Optimistic-row writer for status changes. The annotation already exists
 * in the store; the writer applies `{ status }` to the matching row.
 * Receives the change payload so the writer can decide whether to mutate
 * its store and/or skip when the row is missing.
 */
export type QueueChangeAnnotationStatusOptimisticWriter = (
  input: QueueChangeAnnotationStatusInput,
) => void;

/**
 * Queue an annotation status change:
 *   1. Mint a `localUuid` (used solely as the outbox row id and
 *      `clientRequestId`; the underlying annotation id is unchanged).
 *   2. Persist the outbox entry.
 *   3. Apply the optimistic update.
 *   4. Trigger the Syncer.
 */
export async function queueChangeAnnotationStatus(
  input: QueueChangeAnnotationStatusInput,
  optimistic?: QueueChangeAnnotationStatusOptimisticWriter | null,
  deps?: QueueMutationDeps,
): Promise<QueueMutationResult> {
  const d = resolveDeps(deps);
  const localUuid = d.uuid();
  const createdAt = d.now();

  const payload = {
    annotationId: input.annotationId,
    status: input.status,
    clientRequestId: localUuid,
  };

  await d.enqueueOutbox({
    localUuid,
    kind: 'change-status',
    payload,
    pendingSync: true,
    createdAt,
  });

  if (optimistic) optimistic(input);
  fireAndForgetSync(d.triggerSync);
  return { localUuid };
}

/* -------------------------------------------------------------------------- */
/* Comment create                                                             */
/* -------------------------------------------------------------------------- */

/** Input for a queued comment create. */
export interface QueueCreateCommentInput {
  annotationId: string;
  body: string;
  mentions: string[];
}

/** Optimistic-row writer for comment creates. */
export type QueueCreateCommentOptimisticWriter = (
  comment: FLComment,
) => void;

/**
 * Queue a comment create:
 *   1. Mint a `localUuid` and use it as the optimistic comment id.
 *   2. Persist the outbox entry whose payload mirrors the eventual
 *      `POST /annotations/:id/comments` body.
 *   3. Build and hand off the optimistic `Comment` row.
 *   4. Trigger the Syncer.
 */
export async function queueCreateComment(
  input: QueueCreateCommentInput,
  optimistic?: QueueCreateCommentOptimisticWriter | null,
  deps?: QueueMutationDeps,
): Promise<QueueMutationResult> {
  const d = resolveDeps(deps);
  const localUuid = d.uuid();
  const createdAt = d.now();

  const payload = {
    annotationId: input.annotationId,
    body: input.body,
    mentions: input.mentions,
    clientRequestId: localUuid,
  };

  await d.enqueueOutbox({
    localUuid,
    kind: 'create-comment',
    payload,
    pendingSync: true,
    createdAt,
  });

  if (optimistic) {
    const optimisticRow: FLComment = {
      id: localUuid,
      annotationId: input.annotationId,
      authorId: '',
      body: input.body,
      mentions: input.mentions,
      createdAt,
      clientRequestId: localUuid,
    };
    optimistic(optimisticRow);
  }

  fireAndForgetSync(d.triggerSync);
  return { localUuid };
}
