/**
 * MV3 content-script → service-worker API relay.
 *
 * --------------------------------------------------------------------------
 * Why this exists
 * --------------------------------------------------------------------------
 * Content scripts run in the *host page's* network origin. A `fetch()` from a
 * content script is therefore an ordinary cross-origin request subject to the
 * page origin's CORS policy — so `fetch('http://localhost:3001/api/v1/...')`
 * from `http://example.com` is rejected by the browser unless the API echoes
 * `Access-Control-Allow-Origin: http://example.com`, which it (correctly)
 * never will. The API's CORS layer only allows the dashboard origin.
 *
 * The MV3-correct fix is to relay the request to the extension's service
 * worker and let *it* perform the fetch. Service-worker (and extension-page)
 * fetches are governed by `host_permissions` / `optional_host_permissions`,
 * NOT by the host page's CORS policy, so they reach the API regardless of
 * which site the content script is running on.
 *
 * This module defines:
 *   1. A typed request/response message protocol (`RelayRequest` /
 *      `RelayResponse`), where a `FormData` body is serialised into a
 *      structured, `postMessage`-safe `SerializedForm`.
 *   2. Serialisation helpers (`serializeBody` / `deserializeBody`,
 *      `serializeFormData` / `deserializeFormData`) and base64 codecs that
 *      work in both the worker and content-script contexts.
 *   3. `handleRelayRequest(req)` — the service-worker side. It performs the
 *      fetch with an injected `fetchImpl` + `authTokenProvider` +
 *      `originResolver` and returns a `RelayResponse`.
 *   4. `relayFetch(path, init)` — the content-script side. Sends the message
 *      and reconstructs a real `Response` so every existing caller of
 *      `apiFetchRaw` is unchanged (`.ok` / `.status` / `.json()` / `.text()`
 *      all work).
 *   5. `isContentScriptContext()` — detects "running in a content script"
 *      (a `chrome.runtime.id` is present AND we are NOT on a
 *      `chrome-extension:` page), so `lib/api.ts` can pick the relay path
 *      only where it is actually needed.
 *
 * The worker handler and the content-script client are both dependency-
 * injected so the serialisation and routing logic is unit-testable with
 * plain fakes (no real `chrome.*` and no real network).
 */

/** Discriminator for every relay message so unrelated runtime messages are ignored. */
export const RELAY_MESSAGE_TYPE = 'PP_API_FETCH' as const;

/** A single serialised form field. Either a plain string or a base64 blob. */
export type SerializedFormField =
  | { name: string; kind: 'text'; value: string }
  | {
      name: string;
      kind: 'blob';
      base64: string;
      type: string;
      filename?: string;
    };

/** A `FormData` instance flattened into a `postMessage`-safe array. */
export interface SerializedForm {
  __formData: true;
  fields: SerializedFormField[];
}

/** The request body on the wire: a plain string, a serialised form, or none. */
export type SerializedBody = string | SerializedForm | null;

/** The relay request message sent from a content script to the service worker. */
export interface RelayRequest {
  type: typeof RELAY_MESSAGE_TYPE;
  /** Path relative to the API base, e.g. `/projects/by-url?url=...`. */
  path: string;
  method: string;
  headers: Record<string, string>;
  body: SerializedBody;
  /**
   * When `true`, skip the JSON `Content-Type`/`Accept` defaults — mirrors
   * `ApiFetchOptions.raw`. Carried so the worker reconstructs the exact
   * request the caller intended (FormData uploads set their own boundary).
   */
  raw?: boolean;
}

/** The relay response message the service worker returns to the content script. */
export interface RelayResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Selected response headers (whitelist below) echoed back for reconstruction. */
  headers: Record<string, string>;
  /** Response body as text (used for JSON + text bodies). */
  bodyText: string;
  /**
   * Base64 body for binary responses. `undefined` for the common
   * text/JSON path. When present, the content-script reconstructs the
   * `Response` from the decoded bytes instead of `bodyText`.
   */
  bodyBase64?: string;
  /**
   * Set when the fetch itself threw (network error, blocked, etc.) rather
   * than returning an HTTP response. The content-script client rejects
   * with this message so callers see the same failure shape as a direct
   * `fetch` rejection.
   */
  networkError?: string;
}

/**
 * Response headers worth forwarding back across the relay. We intentionally
 * keep this small: the extension only reads these, and copying every header
 * (e.g. `Set-Cookie`, hop-by-hop headers) across a `postMessage` boundary is
 * both wasteful and a footgun.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'retry-after',
  'x-request-id',
] as const;

/* -------------------------------------------------------------------------- */
/* base64 codecs (work in SW, content script, and Node/vitest)                */
/* -------------------------------------------------------------------------- */

/** Encode a byte array to base64. Prefers `btoa`; falls back to `Buffer`. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      // `String.fromCharCode(...bytes)` overflows the call stack for large
      // payloads (screenshots are ~MBs), so chunk the conversion.
      const slice = bytes.subarray(i, i + chunk);
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoder available in this environment');
}

/** Decode a base64 string to a byte array. Prefers `atob`; falls back to `Buffer`. */
export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('No base64 decoder available in this environment');
}

/* -------------------------------------------------------------------------- */
/* FormData serialisation                                                     */
/* -------------------------------------------------------------------------- */

/** Narrow an unknown body to a `FormData` without assuming the global exists. */
export function isFormData(body: unknown): body is FormData {
  return (
    typeof FormData !== 'undefined' &&
    body instanceof FormData
  );
}

/** Type guard for the serialised-form wire shape. */
export function isSerializedForm(body: unknown): body is SerializedForm {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { __formData?: unknown }).__formData === true &&
    Array.isArray((body as { fields?: unknown }).fields)
  );
}

/**
 * Flatten a `FormData` into a `postMessage`-safe structure. String fields
 * are copied verbatim; `Blob`/`File` fields are read to bytes and base64
 * encoded along with their MIME type and (for files) their filename.
 */
export async function serializeFormData(form: FormData): Promise<SerializedForm> {
  const fields: SerializedFormField[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, kind: 'text', value });
      continue;
    }
    // Blob / File branch.
    const blob = value as Blob & { name?: string };
    const buf = await blob.arrayBuffer();
    fields.push({
      name,
      kind: 'blob',
      base64: bytesToBase64(new Uint8Array(buf)),
      type: blob.type || 'application/octet-stream',
      filename: typeof blob.name === 'string' ? blob.name : undefined,
    });
  }
  return { __formData: true, fields };
}

/** Rebuild a live `FormData` from its serialised form (service-worker side). */
export function deserializeFormData(serialized: SerializedForm): FormData {
  const form = new FormData();
  for (const field of serialized.fields) {
    if (field.kind === 'text') {
      form.append(field.name, field.value);
    } else {
      const bytes = base64ToBytes(field.base64);
      // Copy into a fresh ArrayBuffer so the Blob owns a tightly-sized
      // buffer whose type is a concrete `ArrayBuffer` (not the generic
      // `ArrayBufferLike` the `Uint8Array` view carries, which TS refuses
      // as a `BlobPart`).
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: field.type });
      if (field.filename !== undefined) {
        form.append(field.name, blob, field.filename);
      } else {
        form.append(field.name, blob);
      }
    }
  }
  return form;
}

/* -------------------------------------------------------------------------- */
/* Request body serialisation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a request body for transport. `FormData` becomes a
 * `SerializedForm`; `string`/`null`/`undefined` pass through (the latter two
 * both collapse to `null`). Anything else is rejected — the extension only
 * ever sends JSON strings or `FormData`.
 */
export async function serializeBody(
  body: BodyInit | null | undefined,
): Promise<SerializedBody> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (isFormData(body)) return serializeFormData(body);
  throw new Error(
    'apiRelay only supports string or FormData request bodies',
  );
}

/**
 * Deserialise a wire body back into something `fetch` accepts
 * (service-worker side). A `SerializedForm` becomes live `FormData`;
 * strings and `null` pass through.
 */
export function deserializeBody(body: SerializedBody): BodyInit | null {
  if (body === null) return null;
  if (typeof body === 'string') return body;
  if (isSerializedForm(body)) return deserializeFormData(body);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Service-worker handler                                                     */
/* -------------------------------------------------------------------------- */

/** Dependencies the SW handler needs — injected so the logic is testable. */
export interface RelayHandlerDeps {
  /** `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to {@link RELAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Resolve the API origin (e.g. `http://localhost:3001`). */
  resolveOrigin: () => string | Promise<string>;
  /** API base prefix (e.g. `/api/v1`). */
  apiBase: string;
  /** Resolve the bearer token to attach, or `null` when signed out. */
  authTokenProvider: () => string | null | Promise<string | null>;
}

/** Responses larger than this are returned base64 to survive binary bodies. */
const BINARY_CONTENT_TYPE_RE =
  /^(image\/|application\/octet-stream|application\/pdf|application\/zip)/i;

/** HTTP methods the relay will perform. */
export const ALLOWED_RELAY_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * Validate a relay request BEFORE any URL is built. The relay runs with the
 * extension's host permissions and the bearer token, so a compromised content
 * script (or a forged message) must not be able to steer it outside the API
 * prefix. Returns a human-readable rejection reason, or `null` when safe.
 *
 * Path rules (checked on the path portion, i.e. before any `?`/`#`):
 *   - must be a string starting with a single `/`
 *   - no `..`, `%2e` / `%2E` (dot-segment smuggling), `\` / `%5c`, or `//`
 *   - no URL scheme and no control characters
 * After resolution the URL must stay on the resolved origin and its pathname
 * must start with `apiBase + '/'`.
 */
export function validateRelayRequest(
  req: Pick<RelayRequest, 'path' | 'method'>,
  origin: string,
  apiBase: string,
): string | null {
  if (typeof req.method !== 'string' || !ALLOWED_RELAY_METHODS.has(req.method.toUpperCase())) {
    return 'method not allowed';
  }
  const path = req.path;
  if (typeof path !== 'string' || !path.startsWith('/')) return 'path must start with /';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'path contains control characters';
  const pathOnly = path.split(/[?#]/, 1)[0]!;
  if (pathOnly.includes('..') || /%2e/i.test(pathOnly)) return 'path contains dot segments';
  if (pathOnly.includes('\\') || /%5c/i.test(pathOnly)) return 'path contains a backslash';
  if (pathOnly.includes('//')) return 'path contains //';
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOnly) || /:\/\//.test(pathOnly)) {
    return 'path contains a scheme';
  }
  let resolved: URL;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(origin).origin;
    resolved = new URL(`${origin}${apiBase}${path}`);
  } catch {
    return 'unresolvable URL';
  }
  if (resolved.origin !== expectedOrigin) return 'URL left the API origin';
  if (!resolved.pathname.startsWith(`${apiBase}/`)) return 'URL left the API prefix';
  return null;
}

/**
 * Perform the relayed fetch in the service worker and build a `RelayResponse`.
 *
 * - Resolves the absolute URL from `resolveOrigin()` + `apiBase` + `path`.
 * - Attaches `Authorization: Bearer <token>` when a token is available and
 *   the caller did not already set one.
 * - Reads the body as text by default; for binary content types it reads
 *   the bytes and base64-encodes them.
 * - Never throws for HTTP errors (4xx/5xx come back as a normal
 *   `RelayResponse`). A thrown fetch (network failure) is captured in
 *   `networkError` so the content-script client can reject symmetrically.
 */
export async function handleRelayRequest(
  req: RelayRequest,
  deps: RelayHandlerDeps,
): Promise<RelayResponse> {
  const fetchImpl =
    deps.fetchImpl ??
    (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
      networkError: 'No fetch implementation available in the service worker',
    };
  }

  const origin = await deps.resolveOrigin();
  const rejection = validateRelayRequest(req, origin, deps.apiBase);
  if (rejection !== null) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
      networkError: `Relay request rejected: ${rejection}`,
    };
  }
  const url = `${origin}${deps.apiBase}${req.path}`;

  const headers: Record<string, string> = { ...req.headers };
  // Attach the bearer unless the caller already supplied an Authorization
  // header (e.g. the refresh call, which carries the current token itself).
  const hasAuth = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'authorization',
  );
  if (!hasAuth) {
    const token = await deps.authTokenProvider();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const body = deserializeBody(req.body);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: req.method.toUpperCase(),
      headers,
      body: body ?? undefined,
      // Safety net: a hung request must not wedge the caller (the Syncer
      // drains serially). Surfaces as a `networkError` like any failure.
      signal: relayTimeoutSignal(deps.timeoutMs ?? RELAY_TIMEOUT_MS),
      // Bearer-only client: never send (or store) the dashboard's ambient
      // `fl_session` cookie. With it, the server's double-submit CSRF check
      // applies and every mutation from the extension failed 403.
      credentials: 'omit',
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
      networkError: err instanceof Error ? err.message : String(err),
    };
  }

  const outHeaders: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) outHeaders[name] = value;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const isBinary = BINARY_CONTENT_TYPE_RE.test(contentType);

  if (isBinary) {
    const buf = await res.arrayBuffer();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      bodyText: '',
      bodyBase64: bytesToBase64(new Uint8Array(buf)),
    };
  }

  const bodyText = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
    bodyText,
  };
}

/* -------------------------------------------------------------------------- */
/* Content-script client                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `true` when we are running inside a content script: a `chrome.runtime.id`
 * is present (so messaging is available) AND we are NOT on an extension page
 * (`chrome-extension:`), where direct `fetch` is already allowed. The popup,
 * options page, and the service worker all return `false` here so they keep
 * their existing direct-fetch path.
 */
export function isContentScriptContext(): boolean {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  // Service workers have no `location.protocol` meaningfully tied to a page;
  // they report the extension origin. Extension *pages* report
  // `chrome-extension:`. Only a content script reports the host page's
  // http(s) protocol while still having a `chrome.runtime.id`.
  const protocol =
    typeof location !== 'undefined' ? location.protocol : '';
  if (protocol === 'chrome-extension:') return false;
  // A real document (content scripts always have one) plus a runtime id and a
  // non-extension protocol is the content-script fingerprint.
  return typeof document !== 'undefined';
}

/** Reconstruct a real `Response` from a `RelayResponse`. */
export function responseFromRelay(relay: RelayResponse): Response {
  const headers = new Headers(relay.headers);
  const bodyInit: BodyInit | null =
    relay.bodyBase64 !== undefined
      ? // Copy into a concrete ArrayBuffer so `Response` accepts it.
        (() => {
          const bytes = base64ToBytes(relay.bodyBase64);
          const buffer = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buffer).set(bytes);
          return buffer;
        })()
      : relay.bodyText.length > 0
        ? relay.bodyText
        : null;
  // 204/205/304 must not carry a body, or the `Response` constructor throws.
  const nullBodyStatus = relay.status === 204 || relay.status === 205 || relay.status === 304;
  return new Response(nullBodyStatus ? null : bodyInit, {
    status: relay.status || 0,
    statusText: relay.statusText,
    headers,
  });
}

/** Dependencies the content-script client needs — injected for testability. */
export interface RelayClientDeps {
  /**
   * Send a message to the service worker and resolve with its reply.
   * Defaults to a promisified `chrome.runtime.sendMessage`.
   */
  sendMessage?: (message: RelayRequest) => Promise<RelayResponse>;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** Upper bound for one relayed API request. */
export const RELAY_TIMEOUT_MS = 30_000;

function relayTimeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultSendMessage(message: RelayRequest): Promise<RelayResponse> {
  return new Promise<RelayResponse>((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: RelayResponse) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message ?? 'runtime.sendMessage failed'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Content-script fetch: serialise the request, relay it to the service
 * worker, and reconstruct a real `Response`. Rejects with the worker's
 * `networkError` so callers that catch a direct-`fetch` rejection behave
 * identically behind the relay.
 */
export async function relayFetch(
  path: string,
  init: RequestInit & { raw?: boolean },
  deps: RelayClientDeps = {},
): Promise<Response> {
  const send = deps.sendMessage ?? defaultSendMessage;

  const headers: Record<string, string> = {};
  if (init.headers) {
    // Normalise every supported `HeadersInit` shape into a flat record.
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) headers[key] = value;
    } else {
      Object.assign(headers, init.headers as Record<string, string>);
    }
  }

  const message: RelayRequest = {
    type: RELAY_MESSAGE_TYPE,
    path,
    method: init.method ?? 'GET',
    headers,
    body: await serializeBody(init.body),
    raw: init.raw,
  };

  // Honour the caller's AbortSignal (e.g. the connection monitor's 5 s
  // heartbeat timeout). The message round-trip itself can't be cancelled,
  // but the caller must not stay blocked on a request that hangs in the
  // service worker — that wedged the heartbeat for 30 s+ after reconnecting.
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError(signal);
  const relay = signal
    ? await new Promise<RelayResponse>((resolve, reject) => {
        const onAbort = (): void => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        send(message).then(
          (r) => {
            signal.removeEventListener('abort', onAbort);
            resolve(r);
          },
          (e: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      })
    : await send(message);
  if (relay && relay.networkError) {
    throw new Error(relay.networkError);
  }
  return responseFromRelay(relay);
}
