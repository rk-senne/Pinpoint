/**
 * Verify-email page — vanilla TypeScript (Requirement 31.1, task 18.12).
 *
 * Mounted at `/verify-email/:token` by the dashboard router. On mount the
 * page POSTs to `/api/v1/auth/verify-email/:token` and renders one of three
 * sections of the `#verify-email-page` `<template>`:
 *
 *   - `verifying`  — while the verification call is in flight.
 *   - `success`    — after the server returns 2xx; shows the success message
 *                    "Email verified — you can now sign in" and a link to
 *                    `/login`.
 *   - `error`      — after the server returns a non-2xx response (or the
 *                    request fails); shows the server's error message and a
 *                    "Resend verification" form that POSTs to
 *                    `/api/v1/auth/resend-verification` with the user-entered
 *                    email.
 *
 * Requirements: 20.2, 20.3
 */

import { API_BASE } from '../lib/api';
import { bindEvents, cloneTemplate, mount, text } from '../lib/render';
import { navigate } from '../lib/router';

/**
 * Mount the verify-email page into `rootEl`. The `params.token` is the
 * `:token` segment from the route. Returns a teardown function that
 * unbinds event listeners and removes the page DOM — call this when the
 * router unmounts the page.
 */
export function mountVerifyEmailPage(
  rootEl: HTMLElement,
  params: Record<string, string>,
): () => void {
  const token = params.token ?? '';

  const fragment = cloneTemplate('verify-email-page');
  const pageRoot = fragment.firstElementChild as HTMLElement | null;
  if (!pageRoot) {
    throw new Error('mountVerifyEmailPage: #verify-email-page template is empty');
  }

  const verifyingSection = section(pageRoot, 'verifying');
  const successSection = section(pageRoot, 'success');
  const errorSection = section(pageRoot, 'error');
  const errorMessageSlot = pageRoot.querySelector(
    '[data-section="error"] [data-slot="message"]',
  ) as HTMLElement | null;
  const resendStatusSlot = pageRoot.querySelector(
    '[data-section="error"] [data-slot="resendStatus"]',
  ) as HTMLElement | null;
  const resendForm = pageRoot.querySelector(
    'form[data-form="resend"]',
  ) as HTMLFormElement | null;
  const emailInput = pageRoot.querySelector(
    'input[data-input="email"]',
  ) as HTMLInputElement | null;

  const cleanupEvents = bindEvents(pageRoot, {
    /**
     * Fallback navigation handler — `data-route` already intercepts the
     * link when the router is started, but in unit tests the router is
     * not always wired. The `data-action="goLogin"` attribute keeps the
     * link behavior testable without depending on `start(rootEl)`.
     */
    goLogin: (e) => {
      e.preventDefault();
      navigate('/login');
    },
    /**
     * Submit handler for the resend form. Reads the entered email,
     * POSTs to `/auth/resend-verification`, and surfaces a status
     * message in the `resendStatus` slot. The form is intentionally
     * not disabled while the request is in flight — failure leaves the
     * user free to correct the email and retry.
     */
    resend: (e) => {
      e.preventDefault();
      void handleResend();
    },
  });

  mount(rootEl, fragment);

  // Kick off the verify request after the page is in the DOM so the
  // `verifying` section is visible to screen readers immediately.
  void verify();

  return () => {
    cleanupEvents();
    pageRoot.remove();
  };

  // -------------------------------------------------------------------
  // handlers
  // -------------------------------------------------------------------

  async function verify(): Promise<void> {
    showOnly(verifyingSection);

    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/auth/verify-email/${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
    } catch {
      showError('Network error. Please try again.');
      return;
    }

    if (response.ok) {
      showOnly(successSection);
      return;
    }

    showError(await readErrorMessage(response));
  }

  async function handleResend(): Promise<void> {
    if (!emailInput) return;
    const email = emailInput.value.trim();
    if (!email) {
      setResendStatus('Enter the email address you registered with.');
      return;
    }

    setResendStatus('Sending…');
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      setResendStatus('Network error. Please try again.');
      return;
    }

    if (response.ok) {
      setResendStatus('Verification email sent. Check your inbox.');
      return;
    }

    setResendStatus(await readErrorMessage(response));
  }

  function showOnly(visible: HTMLElement): void {
    for (const s of [verifyingSection, successSection, errorSection]) {
      s.hidden = s !== visible;
    }
  }

  function showError(message: string): void {
    if (errorMessageSlot) text(errorMessageSlot, message);
    if (resendForm) resendForm.reset();
    setResendStatus('');
    showOnly(errorSection);
  }

  function setResendStatus(message: string): void {
    if (resendStatusSlot) text(resendStatusSlot, message);
  }
}

/**
 * Read an error message from the server's JSON envelope, falling back to
 * an HTTP-status-derived message when the body is missing or malformed.
 * The server consistently returns `{ error: { code, message } }` (Req 13.5).
 */
async function readErrorMessage(response: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* malformed or empty body — fall through */
  }
  const message =
    typeof body === 'object' && body !== null
      ? // narrow to `{ error?: { message?: string } }` without trusting it
        ((body as { error?: { message?: string } }).error?.message ?? null)
      : null;
  if (typeof message === 'string' && message.length > 0) return message;
  return `Verification failed (HTTP ${response.status}).`;
}

function section(root: HTMLElement, name: string): HTMLElement {
  const el = root.querySelector(`[data-section="${name}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(
      `mountVerifyEmailPage: template is missing the "${name}" section`,
    );
  }
  return el;
}
