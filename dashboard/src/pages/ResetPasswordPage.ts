/**
 * ResetPasswordPage — the two halves of the password-reset flow.
 *
 *   /reset-password          asks for an email and calls
 *                            POST /api/v1/auth/reset-password (always the same
 *                            generic answer — no account oracle).
 *   /reset-password/:token   (the link in the reset email) asks for a new
 *                            password and calls
 *                            POST /api/v1/auth/reset-password/:token.
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './ResetPasswordPage.templates.html?raw';
import { API_BASE } from '../lib/api';
import { bindEvents, cloneTemplate, mount, requireSlot, text } from '../lib/render';
import { navigate } from '../lib/router';

/**
 * POST JSON without credentials: the page is public and token-authenticated,
 * and a session cookie from a logged-in tab would fail the CSRF check.
 */
async function postPublic(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  let message = `Request failed (HTTP ${res.status}).`;
  try {
    const parsed = (await res.json()) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    /* keep the generic message */
  }
  throw new Error(message);
}

export function mountResetPasswordPage(
  rootEl: HTMLElement,
  params: Record<string, string> = {},
): () => void {
  registerTemplates('reset-password', templatesHtml);
  const token = params.token ?? '';
  const completing = token !== '';

  const fragment = cloneTemplate('tpl-reset-password');
  const pageRoot = fragment.firstElementChild as HTMLElement | null;
  if (!pageRoot) throw new Error('mountResetPasswordPage: template is empty');

  const messageEl = requireSlot(pageRoot, 'message');
  const emailField = requireSlot(pageRoot, 'emailField');
  const passwordField = requireSlot(pageRoot, 'passwordField');
  const submitBtn = requireSlot(pageRoot, 'submitBtn') as HTMLButtonElement;
  const emailInput = pageRoot.querySelector('input[name="email"]') as HTMLInputElement;
  const passwordInput = pageRoot.querySelector('input[name="password"]') as HTMLInputElement;

  text(requireSlot(pageRoot, 'title'), completing ? 'Choose a new password' : 'Reset your password');
  text(
    requireSlot(pageRoot, 'hint'),
    completing
      ? 'Enter a new password for your account.'
      : 'Enter your email and we will send you a reset link.',
  );
  text(submitBtn, completing ? 'Set new password' : 'Send reset link');
  if (completing) {
    emailField.setAttribute('hidden', '');
    passwordField.removeAttribute('hidden');
  }

  function show(msg: string, tone: 'error' | 'info'): void {
    text(messageEl, msg);
    messageEl.dataset.tone = tone;
    messageEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    messageEl.style.background = tone === 'error' ? 'var(--pp-error-bg)' : 'var(--pp-bg-hover)';
    messageEl.style.color = tone === 'error' ? 'var(--pp-error-text)' : 'var(--pp-text-primary)';
    messageEl.removeAttribute('hidden');
  }

  async function submit(): Promise<void> {
    messageEl.setAttribute('hidden', '');
    if (completing ? !passwordInput.value : !emailInput.value.trim()) {
      show(completing ? 'Please enter a new password.' : 'Please enter your email.', 'error');
      return;
    }
    submitBtn.disabled = true;
    try {
      if (completing) {
        await postPublic(`/auth/reset-password/${encodeURIComponent(token)}`, {
          password: passwordInput.value,
        });
        navigate('/login');
      } else {
        await postPublic('/auth/reset-password', { email: emailInput.value.trim() });
        show('If an account with that email exists, a reset link has been sent.', 'info');
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'An unexpected error occurred.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  }

  const cleanupEvents = bindEvents(pageRoot, {
    submit: (e) => {
      e.preventDefault();
      void submit();
    },
  });

  mount(rootEl, fragment);
  return () => {
    cleanupEvents();
    pageRoot.remove();
  };
}
