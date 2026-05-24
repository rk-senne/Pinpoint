/**
 * SharedProjectView — vanilla-TS page for the password-protected shared link
 * flow.
 *
 * Migration of `dashboard/src/pages/SharedProjectView.tsx` per Task 18.11.
 * Uses the shared `<template>` markup in `index.html`, the render helpers in
 * `lib/render.ts`, and `signal<T>` from the shared package. No React.
 *
 * Flow (Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6):
 *   1. Mount renders the password prompt for the given `linkId`.
 *   2. Submit POSTs to `/api/v1/shared/:linkId/verify`.
 *      - 200 → render the read-only annotations view.
 *      - 401 → display the inline error and the `attemptsRemaining` field
 *               from the response (falling back to a client-side counter
 *               when the server omits it).
 *      - 423 → switch to the locked screen and start a per-second countdown
 *               driven by the response's `Retry-After` header. When the
 *               countdown reaches zero, the lock is dismissed and the user
 *               is returned to the prompt.
 *      - 404 → switch to the not-found screen.
 *      - Network/other → inline error.
 *   3. Unmounting (route change) clears the countdown interval.
 */

import { signal, type Signal } from '@pinpoint/shared';
import type { Annotation } from '@pinpoint/shared';
import { SEVERITY_COLORS, STATUS_LABELS } from '@pinpoint/shared';

import { API_BASE } from '../lib/api';
import { attr, bindEvents, cloneTemplate, mount, text } from '../lib/render';

/** Visible top-level state of the page. */
type ViewState = 'prompt' | 'locked' | 'not_found' | 'authenticated';

/** Sections in the template that we toggle via `hidden`. */
const SECTIONS: ViewState[] = ['prompt', 'locked', 'not_found', 'authenticated'];

// Severity colors and status labels are imported from `@pinpoint/shared`
// (Requirement 26.3). The legacy inline maps that previously lived here have
// been removed in favor of the canonical palette in `shared/src/theme.ts`.

const MAX_FAILED_ATTEMPTS = 3;

/**
 * Mount the shared-project view inside `node`. Designed to be passed to
 * `defineRoute('/shared/:linkId', mountSharedProjectView)`.
 *
 * Returns a teardown that stops the lockout countdown timer and unsubscribes
 * every signal binding registered by this call. The router invokes the
 * teardown before mounting the next route.
 */
export function mountSharedProjectView(
  node: HTMLElement,
  params: Record<string, string>,
): () => void {
  const linkId = params.linkId ?? '';

  // --- View signals ---------------------------------------------------
  const view: Signal<ViewState> = signal<ViewState>('prompt');
  const error: Signal<string> = signal<string>('');
  const password: Signal<string> = signal<string>('');
  const verifying: Signal<boolean> = signal<boolean>(false);
  const failedAttempts: Signal<number> = signal<number>(0);
  const annotations: Signal<Annotation[]> = signal<Annotation[]>([]);
  /** Seconds remaining on the active lockout. 0 when not locked. */
  const lockSecondsRemaining: Signal<number> = signal<number>(0);

  // --- Mount the template --------------------------------------------
  mount(node, cloneTemplate('tpl-shared-project-view'));
  const root = node.querySelector<HTMLElement>('[data-fl-shared-root]')!;
  const passwordInput = root.querySelector<HTMLInputElement>('[data-slot="password-input"]')!;
  const promptErrorEl = root.querySelector<HTMLElement>('[data-slot="prompt-error"]')!;
  const submitBtn = root.querySelector<HTMLButtonElement>('[data-slot="submit-btn"]')!;
  const lockedMessageEl = root.querySelector<HTMLElement>('[data-slot="locked-message"]')!;
  const emptyStateEl = root.querySelector<HTMLElement>('[data-slot="empty-state"]')!;
  const tableEl = root.querySelector<HTMLElement>('[data-slot="annotations-table"]')!;
  const tbodyEl = root.querySelector<HTMLElement>('[data-slot="annotations-tbody"]')!;

  // --- Event wiring ---------------------------------------------------
  passwordInput.addEventListener('input', () => {
    password.set(passwordInput.value);
  });

  bindEvents(root, {
    verify: (e: Event) => {
      e.preventDefault();
      void verify();
    },
  });

  // --- Reactive bindings ---------------------------------------------
  const unsubs: Array<() => void> = [];

  unsubs.push(
    view.subscribe((current) => {
      for (const section of SECTIONS) {
        const el = root.querySelector<HTMLElement>(`[data-section="${section}"]`);
        if (!el) continue;
        if (section === current) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
      }
    }),
  );

  unsubs.push(
    error.subscribe((message) => {
      text(promptErrorEl, message);
      if (message) promptErrorEl.removeAttribute('hidden');
      else promptErrorEl.setAttribute('hidden', '');
    }),
  );

  unsubs.push(
    verifying.subscribe((isVerifying) => {
      const pwd = password.get();
      submitBtn.disabled = isVerifying || pwd.length === 0;
      attr(submitBtn, 'style', baseSubmitStyle(isVerifying));
      text(submitBtn, isVerifying ? 'Verifying…' : 'Unlock');
    }),
  );

  unsubs.push(
    password.subscribe((value) => {
      // Keep the disabled state in sync as the user types.
      submitBtn.disabled = verifying.get() || value.length === 0;
      // Avoid clobbering the input field while the user is typing — only
      // overwrite when the signal diverges (e.g. after a successful verify).
      if (passwordInput.value !== value) passwordInput.value = value;
    }),
  );

  unsubs.push(
    lockSecondsRemaining.subscribe((secs) => {
      const minutes = Math.max(1, Math.ceil(secs / 60));
      const minuteWord = minutes === 1 ? 'minute' : 'minutes';
      text(
        lockedMessageEl,
        `Too many failed password attempts. Please try again in ${minutes} ${minuteWord}.`,
      );
    }),
  );

  unsubs.push(
    annotations.subscribe((rows) => {
      tbodyEl.replaceChildren();
      if (rows.length === 0) {
        emptyStateEl.removeAttribute('hidden');
        tableEl.setAttribute('hidden', '');
        return;
      }
      emptyStateEl.setAttribute('hidden', '');
      tableEl.removeAttribute('hidden');
      for (const a of rows) {
        const fragment = cloneTemplate('tpl-shared-project-view-row', {
          'pin-number': String(a.pinNumber),
          type: a.type,
          severity: a.severity,
          status: STATUS_LABELS[a.status] ?? a.status,
          body: a.body ?? '',
        });
        const severityEl = fragment.querySelector<HTMLElement>('[data-slot="severity"]');
        if (severityEl) {
          attr(severityEl, 'style', `font-weight: 500; color: ${SEVERITY_COLORS[a.severity] ?? '#333'};`);
        }
        tbodyEl.appendChild(fragment);
      }
    }),
  );

  // --- Lockout countdown ---------------------------------------------
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function startCountdown(seconds: number): void {
    stopCountdown();
    lockSecondsRemaining.set(Math.max(1, Math.floor(seconds)));
    countdownTimer = setInterval(() => {
      const next = lockSecondsRemaining.get() - 1;
      if (next <= 0) {
        stopCountdown();
        lockSecondsRemaining.set(0);
        // Lock cleared — return to the prompt with reset state.
        failedAttempts.set(0);
        password.set('');
        passwordInput.value = '';
        error.set('');
        view.set('prompt');
        return;
      }
      lockSecondsRemaining.set(next);
    }, 1000);
  }

  function stopCountdown(): void {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // --- Verify network call -------------------------------------------
  async function verify(): Promise<void> {
    if (!linkId || verifying.get() || view.get() === 'locked') return;
    const pwd = password.get();
    if (pwd.length === 0) return;

    verifying.set(true);
    error.set('');

    try {
      const res = await fetch(`${API_BASE}/shared/${encodeURIComponent(linkId)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });

      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { annotations?: Annotation[] };
        annotations.set(data.annotations ?? []);
        view.set('authenticated');
        return;
      }

      if (res.status === 423) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        startCountdown(retryAfter);
        view.set('locked');
        return;
      }

      if (res.status === 404) {
        view.set('not_found');
        return;
      }

      // 401 (incorrect password) and other 4xx are surfaced inline.
      const body = (await res.json().catch(() => null)) as
        | { error?: { details?: { attemptsRemaining?: number } } }
        | null;

      const serverRemaining = body?.error?.details?.attemptsRemaining;
      let remaining: number;
      if (typeof serverRemaining === 'number') {
        remaining = Math.max(0, serverRemaining);
        failedAttempts.set(MAX_FAILED_ATTEMPTS - remaining);
      } else {
        const attempts = failedAttempts.get() + 1;
        failedAttempts.set(attempts);
        remaining = Math.max(0, MAX_FAILED_ATTEMPTS - attempts);
      }

      if (remaining <= 0) {
        // Defensive fallback — server should have returned 423, but if it
        // returned 401 with attemptsRemaining=0 we treat it as locked.
        startCountdown(15 * 60);
        view.set('locked');
        return;
      }

      const attemptWord = remaining === 1 ? 'attempt' : 'attempts';
      error.set(`Incorrect password. ${remaining} ${attemptWord} remaining.`);
    } catch {
      error.set('Network error. Please try again.');
    } finally {
      verifying.set(false);
    }
  }

  // --- Cleanup -------------------------------------------------------
  // The router invokes this teardown before mounting the next route, so
  // we stop the countdown timer and unsubscribe each signal binding.
  return () => {
    stopCountdown();
    for (const u of unsubs) u();
    if (root.parentNode) root.remove();
  };
}

/**
 * Parse a `Retry-After` header value. The HTTP spec allows either a delta in
 * seconds or an HTTP date; the server emits seconds. We tolerate both and
 * fall back to the 15-minute default if the value is missing or unparseable.
 */
function parseRetryAfter(value: string | null): number {
  if (!value) return 15 * 60;
  const trimmed = value.trim();
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && asInt > 0) return asInt;
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = Math.ceil((asDate - Date.now()) / 1000);
    if (delta > 0) return delta;
  }
  return 15 * 60;
}

function baseSubmitStyle(isVerifying: boolean): string {
  const cursor = isVerifying ? 'not-allowed' : 'pointer';
  return [
    'width: 100%',
    'padding: 8px',
    'background: #4f46e5',
    'color: #fff',
    'border: none',
    'border-radius: 4px',
    `cursor: ${cursor}`,
    'font-size: 14px',
    'font-weight: 500',
  ].join('; ');
}
