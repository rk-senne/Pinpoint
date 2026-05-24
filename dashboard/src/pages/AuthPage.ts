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

import { apiFetch } from '../lib/api';
import { setCsrfToken, setToken } from '../lib/auth';
import { attr, bindEvents, cloneTemplate, mount, requireSlot, text } from '../lib/render';
import { navigate } from '../lib/router';
import { setCurrentUser } from '../lib/stores';

type AuthMode = 'login' | 'register';

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

  // ---- Render helpers -----------------------------------------------------
  function renderModeChrome(m: AuthMode): void {
    text(titleEl, m === 'login' ? 'Log In' : 'Register');
    text(switchPrompt, m === 'login' ? "Don't have an account? " : 'Already have an account? ');
    text(switchBtn, m === 'login' ? 'Register' : 'Log In');

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
      isLoading ? 'Please wait…' : m === 'login' ? 'Log In' : 'Register',
    );
  }

  function renderError(msg: string): void {
    if (msg) {
      text(errorEl, msg);
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
      errorMessage.set('');
    },
  });

  async function handleSubmit(): Promise<void> {
    errorMessage.set('');

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const name = nameInput.value.trim();
    const m = mode.get();

    if (!email || !password || (m === 'register' && !name)) {
      errorMessage.set('Please fill in all fields.');
      return;
    }

    loading.set(true);
    try {
      const path = m === 'login' ? '/auth/login' : '/auth/register';
      const body = m === 'login' ? { email, password } : { email, password, name };

      const data = await apiFetch<AuthResponse>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });

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
    } catch (err) {
      errorMessage.set(
        err instanceof Error ? err.message : 'An unexpected error occurred.',
      );
    } finally {
      loading.set(false);
    }
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
