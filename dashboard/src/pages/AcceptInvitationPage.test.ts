// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { invitationErrorMessage, mountAcceptInvitationPage } from './AcceptInvitationPage';
import { ApiError } from '../lib/api';

const tick = () => new Promise((r) => setTimeout(r, 0));
const status = (root: HTMLElement) => root.querySelector('[data-role="invite-status"]')!.textContent ?? '';

afterEach(() => {
  document.body.replaceChildren();
});

describe('AcceptInvitationPage', () => {
  it('explains an incomplete link and never calls the API', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const apiFetch = vi.fn();
    mountAcceptInvitationPage(root, {}, { search: '', apiFetch: apiFetch as never, probeIsAuthed: async () => true });
    await tick();
    expect(status(root)).toMatch(/incomplete/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('asks a signed-out visitor to log in first', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    mountAcceptInvitationPage(root, {}, { search: '?token=abc', probeIsAuthed: async () => false });
    await tick();
    expect(status(root)).toMatch(/log in/i);
    expect(root.querySelector('[data-role="invite-login"]')?.getAttribute('href')).toBe('/auth');
  });

  it('accepts, switches into the new org, then navigates home', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const apiFetch = vi.fn(async (path: string) =>
      path === '/org/invitations/accept' ? { membership: { orgId: 'org-2' } } : { token: 'jwt-org-2' },
    );
    const navigate = vi.fn();
    mountAcceptInvitationPage(root, {}, {
      search: '?token=tok-123',
      apiFetch: apiFetch as never,
      probeIsAuthed: async () => true,
      navigate,
    });
    await tick();
    (root.querySelector('[data-role="invite-accept"]') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/org/invitations/accept', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'tok-123' }) }));
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/org/switch', expect.objectContaining({ body: JSON.stringify({ orgId: 'org-2' }) }));
    expect(navigate).toHaveBeenCalledWith('/');
    expect(root.textContent).not.toContain('tok-123');
  });

  it('shows a specific message on failure and re-enables the button', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const apiFetch = vi.fn(async () => {
      throw new ApiError('nope', 'NOT_FOUND', 404);
    });
    mountAcceptInvitationPage(root, {}, { search: '?token=x', apiFetch: apiFetch as never, probeIsAuthed: async () => true });
    await tick();
    const btn = root.querySelector('[data-role="invite-accept"]') as HTMLButtonElement;
    btn.click();
    await tick();
    expect(status(root)).toMatch(/invalid, has expired/i);
    expect(btn.disabled).toBe(false);
  });

  it('maps error codes to copy', () => {
    expect(invitationErrorMessage(new ApiError('x', 'CONFLICT', 409))).toMatch(/already a member/i);
    expect(invitationErrorMessage(new Error('boom'))).toMatch(/try again/i);
  });
});
