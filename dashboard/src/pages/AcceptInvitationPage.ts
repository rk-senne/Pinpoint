/**
 * AcceptInvitationPage — landing page for the org-invitation email link
 * (`/invitations/accept?token=…`).
 *
 * The server binds acceptance to the invited email, so the visitor must be
 * signed in as that address. Flow:
 *   - no token in the URL        → explain the link is incomplete
 *   - not signed in              → ask them to log in, then reopen the link
 *   - signed in                  → "Accept invitation" button → POST
 *     /api/v1/org/invitations/accept { token } → success or a clear error
 *
 * The token is read from the query string and never rendered or stored.
 * All text is written with setText/el (no innerHTML).
 */

import { el, setText } from '@pinpoint/shared';
import { apiFetch as defaultApiFetch, ApiError } from '../lib/api';
import { probeIsAuthed as defaultProbe, setToken } from '../lib/auth';
import { navigate as defaultNavigate } from '../lib/router';

export interface AcceptInvitationOptions {
  apiFetch?: typeof defaultApiFetch;
  probeIsAuthed?: () => Promise<boolean>;
  /** Defaults to window.location.search. */
  search?: string;
  navigate?: (path: string) => void;
}

/** Map server error codes to user-facing copy. */
export function invitationErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'This invitation was sent to a different email address. Log in with the invited account to accept it.';
    if (err.status === 404 || err.status === 410) return 'This invitation is invalid, has expired, or was sent to a different email address. Check you are logged in with the invited account, or ask for a new invitation.';
    if (err.status === 409) return 'You are already a member of this organization.';
  }
  return 'Something went wrong accepting the invitation. Please try again.';
}

export function mountAcceptInvitationPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
  options: AcceptInvitationOptions = {},
): () => void {
  const apiFetch = options.apiFetch ?? defaultApiFetch;
  const probe = options.probeIsAuthed ?? defaultProbe;
  const go = options.navigate ?? defaultNavigate;
  const token = new URLSearchParams(options.search ?? window.location.search).get('token') ?? '';

  const heading = el('h1', { tabindex: '-1' });
  setText(heading, 'Join organization');
  const status = el('p', { role: 'status', 'aria-live': 'polite', 'data-role': 'invite-status' });
  const action = el('div', { 'data-role': 'invite-action' });
  const card = el('main', { class: 'accept-invitation', 'data-page': 'accept-invitation' }, [heading, status, action]);
  card.style.cssText =
    'max-width:440px;margin:80px auto;padding:32px;box-sizing:border-box;width:calc(100% - 32px);' +
    'background:var(--pp-bg-primary);border:1px solid var(--pp-border);border-radius:8px;box-shadow:var(--pp-shadow);';
  heading.style.cssText = 'margin:0 0 8px;font-size:22px;';
  status.style.cssText = 'margin:0 0 20px;color:var(--pp-text-secondary);font-size:14px;line-height:1.5;';
  rootEl.appendChild(card);
  heading.focus();

  let disposed = false;
  const show = (msg: string): void => {
    if (!disposed) setText(status, msg);
  };

  void (async () => {
    if (!token) {
      show('This invitation link is incomplete. Open the link from your invitation email again.');
      return;
    }
    if (!(await probe())) {
      show('Log in with the invited email address, then open this link again to accept.');
      const login = el('a', { href: '/auth', 'data-route': '', 'data-role': 'invite-login', class: 'pp-btn-primary' });
      setText(login, 'Log in');
      action.replaceChildren(login);
      return;
    }
    show('You have been invited to join an organization on Pinpoint.');
    const btn = el('button', { type: 'button', 'data-role': 'invite-accept', class: 'pp-btn-primary' });
    setText(btn, 'Accept invitation');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      show('Accepting…');
      try {
        const accepted = await apiFetch<{ membership: { orgId: string } }>('/org/invitations/accept', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        // Make the new org the active one (re-issues the session cookie).
        const switched = await apiFetch<{ token: string }>('/org/switch', {
          method: 'POST',
          body: JSON.stringify({ orgId: accepted.membership.orgId }),
        });
        setToken(switched.token);
        show('Invitation accepted.');
        go('/');
      } catch (err) {
        show(invitationErrorMessage(err));
        btn.disabled = false;
      }
    });
    action.replaceChildren(btn);
  })();

  return () => {
    disposed = true;
    card.remove();
  };
}
