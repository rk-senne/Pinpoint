/**
 * AuthPage — vanilla TypeScript (Requirement 31.1, task 18.4).
 *
 * Replaces `AuthPage.tsx` with a no-React module that:
 *   1. Clones the `#tpl-auth-page` `<template>` from `index.html`.
 *   2. Toggles between Login and Register modes via a single in-page signal.
 *   3. POSTs to `/api/v1/auth/login` or `/api/v1/auth/register` and surfaces
 *      validation/server errors inline.
 *   4. On success, captures the token via `setToken`, mirrors the user into
 *      `authStore.currentUser` (via `setCurrentUser` so `isAuthenticated`
 *      flips alongside it), and navigates to `/`.
 *
 * The exported `mountAuthPage` matches the `RouteHandler` shape of
 * `lib/router.ts` so it can be registered with `defineRoute('/login', ...)`.
 * It additionally returns a teardown function — useful for tests and for
 * future re-mounts — but `RouteHandler` is `void`-returning so callers from
 * the router simply ignore the value.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 31.1
 */

import { signal } from '@pinpoint/shared';
import type { User } from '@pinpoint/shared';

import { ApiError, apiFetch } from '../lib/api';
import { setCsrfToken, setToken } from '../lib/auth';
import { attr, bindEvents, cloneTemplate, mount, requireSlot, text } from '../lib/render';
import { navigate } from '../lib/router';
import { setCurrentUser } from '../lib/stores';
import { mountTermsConsent } from '../components/TermsConsent';

type AuthMode = 'login' | 'register' | 'mfa';

/** Step-one answer for an account with 2FA on: no session yet, only a short-lived challenge. */
interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
}

interface AuthResponse {
  user: User;
  /** JWT used by the Socket.IO handshake (in-memory only, Req 18.6). */
  token: string;
  /**
   * Double-submit CSRF token mirrored from the `fl_csrf` cookie. Captured
   * here by the AuthPage and echoed by `apiFetch` on every state-changing
   * request (Task 7.4 / Req 18.4).
   */
  csrfToken?: string;
}

/**
 * Mount the vanilla AuthPage into `rootEl`. The optional `params` argument
 * is accepted (and ignored) so the function is directly assignable to the
 * `RouteHandler` type exported by `lib/router.ts`.
 *
 * Returns a teardown function that removes the rendered DOM and detaches
 * every event listener registered by this call.
 */
export function mountAuthPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  const fragment = cloneTemplate('tpl-auth-page');
  const pageRoot = fragment.firstElementChild as HTMLElement | null;
  if (!pageRoot) {
    throw new Error('mountAuthPage: #tpl-auth-page template is empty');
  }

  // ---- Local UI state -----------------------------------------------------
  // Page-scoped signals. Login/register state is not shared across screens,
  // so it does not belong in the global stores.
  const mode = signal<AuthMode>('login');
  const errorMessage = signal<string>('');
  /** Non-error status line (e.g. "check your email" after registering). */
  const noticeMessage = signal<string>('');
  const loading = signal<boolean>(false);

  // ---- DOM refs -----------------------------------------------------------
  const titleEl = requireSlot(pageRoot, 'title');
  const errorEl = requireSlot(pageRoot, 'error');
  const nameField = requireSlot(pageRoot, 'nameField');
  const nameInput = requireInput(pageRoot, 'name');
  const emailInput = requireInput(pageRoot, 'email');
  const passwordInput = requireInput(pageRoot, 'password');
  const submitBtn = requireSlot(pageRoot, 'submitBtn') as HTMLButtonElement;
  const switchPrompt = requireSlot(pageRoot, 'switchPrompt');
  const switchBtn = requireSlot(pageRoot, 'switchBtn');
  const mfaField = requireSlot(pageRoot, 'mfaField');
  const codeInput = requireInput(pageRoot, 'code');
  const emailField = (emailInput.closest('.fl-auth-page__field') ?? emailInput.parentElement) as HTMLElement;
  const passwordField = (passwordInput.closest('.fl-auth-page__field') ?? passwordInput.parentElement) as HTMLElement;
  const forgotRow = pageRoot.querySelector<HTMLElement>('[data-slot="forgotRow"]');
  /** Challenge from step one; memory only, never persisted. */
  let mfaToken = '';
  // Required "I agree to the Terms and Privacy Policy" checkbox (register mode only).
  const termsConsent = mountTermsConsent(submitBtn);

  // ---- Render helpers -----------------------------------------------------
  function renderModeChrome(m: AuthMode): void {
    text(titleEl, m === 'login' ? 'Log In' : m === 'register' ? 'Register' : 'Two-factor authentication');
    text(
      switchPrompt,
      m === 'login' ? "Don't have an account? " : m === 'register' ? 'Already have an account? ' : '',
    );
    text(switchBtn, m === 'login' ? 'Register' : m === 'register' ? 'Log In' : 'Back to log in');

    // Step two replaces the credential fields with the code field.
    const inMfa = m === 'mfa';
    emailField.hidden = inMfa;
    passwordField.hidden = inMfa;
    mfaField.hidden = !inMfa;
    if (forgotRow) forgotRow.hidden = inMfa;
    if (inMfa) codeInput.focus();

    termsConsent.setVisible(m === 'register');
    if (m === 'register') {
      nameField.removeAttribute('hidden');
      attr(nameInput, 'required', '');
    } else {
      attr(nameField, 'hidden', '');
      nameInput.removeAttribute('required');
      nameInput.value = '';
    }
  }

  function renderSubmitButton(m: AuthMode, isLoading: boolean): void {
    submitBtn.disabled = isLoading;
    text(
      submitBtn,
      isLoading ? 'Please wait…' : m === 'register' ? 'Register' : m === 'mfa' ? 'Verify' : 'Log In',
    );
  }

  function renderError(msg: string): void {
    // The error slot doubles as the notice line; `data-tone` lets CSS style
    // the two differently while keeping a single aria-live region.
    const shown = msg || noticeMessage.get();
    if (shown) {
      text(errorEl, shown);
      errorEl.dataset.tone = msg ? 'error' : 'info';
      errorEl.setAttribute('role', msg ? 'alert' : 'status');
      errorEl.removeAttribute('hidden');
    } else {
      text(errorEl, '');
      attr(errorEl, 'hidden', '');
    }
  }

  // ---- Reactive subscriptions --------------------------------------------
  const subscriptions: Array<() => void> = [
    mode.subscribe((m) => {
      renderModeChrome(m);
      renderSubmitButton(m, loading.get());
    }),
    loading.subscribe((isLoading) => {
      renderSubmitButton(mode.get(), isLoading);
    }),
    errorMessage.subscribe((msg) => {
      renderError(msg);
    }),
    noticeMessage.subscribe(() => {
      renderError(errorMessage.get());
    }),
  ];

  // ---- Event wiring -------------------------------------------------------
  const cleanupEvents = bindEvents(pageRoot, {
    submit: (e) => {
      e.preventDefault();
      void handleSubmit();
    },
    toggleMode: (e) => {
      e.preventDefault();
      mode.set(mode.get() === 'login' ? 'register' : 'login');
      mfaToken = '';
      codeInput.value = '';
      errorMessage.set('');
    },
  });

  async function handleSubmit(): Promise<void> {
    errorMessage.set('');
    noticeMessage.set('');

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const name = nameInput.value.trim();
    const m = mode.get();

    if (m === 'mfa') {
      await handleMfaSubmit();
      return;
    }

    if (!email || !password || (m === 'register' && !name)) {
      errorMessage.set('Please fill in all fields.');
      return;
    }

    if (m === 'register' && !termsConsent.isChecked()) {
      termsConsent.setError('You must agree to the Terms of Service and Privacy Policy to register.');
      return;
    }
    termsConsent.setError(null);

    loading.set(true);
    try {
      const path = m === 'login' ? '/auth/login' : '/auth/register';
      const body = m === 'login' ? { email, password } : { email, password, name, acceptTerms: true };

      const data = await apiFetch<AuthResponse | MfaChallengeResponse>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if ('mfaRequired' in data) {
        // Password accepted; the server wants a second factor before it issues a session.
        mfaToken = data.mfaToken;
        passwordInput.value = '';
        codeInput.value = '';
        mode.set('mfa');
        return;
      }

      if (m === 'register') {
        // Registration never signs the user in: the account must be
        // verified first, and the server answers identically whether or not
        // the email already exists (no enumeration). Tell the user what to
        // do next and switch to the login form.
        passwordInput.value = '';
        mode.set('login');
        noticeMessage.set('Check your email to verify your account, then log in.');
        return;
      }

      completeSignIn(data);
    } catch (err) {
      errorMessage.set(
        err instanceof Error ? err.message : 'An unexpected error occurred.',
      );
    } finally {
      loading.set(false);
    }
  }

  async function handleMfaSubmit(): Promise<void> {
    const code = codeInput.value.trim();
    if (!code) {
      errorMessage.set('Enter your authentication code.');
      return;
    }
    loading.set(true);
    try {
      const data = await apiFetch<AuthResponse>('/auth/login/mfa', {
        method: 'POST',
        body: JSON.stringify({ mfaToken, code }),
      });
      completeSignIn(data);
    } catch (err) {
      codeInput.value = '';
      if (err instanceof ApiError && err.code === 'MFA_CHALLENGE_INVALID') {
        // The 5-minute challenge expired: start over from the password step.
        mfaToken = '';
        mode.set('login');
      }
      errorMessage.set(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      loading.set(false);
    }
  }

  function completeSignIn(data: AuthResponse): void {
    setToken(data.token);
    // Capture the CSRF token mirrored in the login response into the
    // module-level slot read by `apiFetch` (Task 7.4, Req 18.4). The
    // store no longer mirrors the token because no consumer needed
    // reactive subscription to its raw value.
    if (data.csrfToken) {
      setCsrfToken(data.csrfToken);
    }
    setCurrentUser(data.user);
    navigate('/');
  }

  mount(rootEl, fragment);

  return () => {
    cleanupEvents();
    for (const unsubscribe of subscriptions) unsubscribe();
    pageRoot.remove();
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function requireInput(root: ParentNode, inputName: string): HTMLInputElement {
  const el = root.querySelector(`input[name="${inputName}"]`);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`mountAuthPage: missing input[name="${inputName}"] in template`);
  }
  return el;
}
