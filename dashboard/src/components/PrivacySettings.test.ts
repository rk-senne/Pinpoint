// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { setCsrfToken, getCsrfToken } from '../lib/auth';
import { installPrivacyTab } from './PrivacySettings';
import privacySource from './PrivacySettings.ts?raw';

function settingsShell(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div data-role="tabs"><button data-role="tab-profile">Profile</button><button data-role="tab-teams">Teams</button></div>
    <section data-section="profile"></section>
    <section data-section="teams" hidden></section>`;
  document.body.appendChild(root);
  return root;
}

type Handler = (path: string, init?: RequestInit) => unknown;
function fakeApi(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fn = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ path, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    const h = routes[`${method} ${path}`];
    if (!h) throw new Error(`unexpected ${method} ${path}`);
    return h(path, init);
  });
  return { fn: fn as never, calls };
}

const $ = (root: ParentNode, role: string): HTMLElement => root.querySelector(`[data-role="${role}"]`) as HTMLElement;
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

beforeEach(() => { document.body.innerHTML = ''; setCsrfToken('t'); });
afterEach(() => { document.body.innerHTML = ''; setCsrfToken(null); });

function memberApi(role: string) {
  return fakeApi({
    'GET /users/me': () => ({ user: { id: 'u1' } }),
    'GET /org/members': () => ({ data: [{ userId: 'u1', role }, { userId: 'u2', role: 'member' }] }),
    'GET /org': () => ({ org: { name: 'Acme' } }),
  });
}

describe('installPrivacyTab', () => {
  it('adds a Privacy tab + hidden section, switches in and out cleanly', async () => {
    const root = settingsShell();
    const api = memberApi('member');
    const handle = installPrivacyTab(root, { apiFetch: api.fn, navigate: vi.fn() })!;
    const section = root.querySelector<HTMLElement>('[data-section="privacy"]')!;
    expect(section.hidden).toBe(true);
    $(root, 'tab-privacy').click();
    await flush();
    expect(section.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-section="profile"]')!.hidden).toBe(true);
    expect($(root, 'tab-privacy').style.fontWeight).toBe('600');
    // Another tab hides it again.
    $(root, 'tab-teams').click();
    expect(section.hidden).toBe(true);
    expect($(root, 'tab-privacy').style.fontWeight).toBe('400');
    handle.dispose();
    expect(root.querySelector('[data-section="privacy"]')).toBeNull();
    expect($(root, 'tab-privacy')).toBeNull();
  });

  it('shows org export to admins, org deletion only to owners, nothing extra to members', async () => {
    for (const [role, orgExport, orgDelete] of [['member', false, false], ['viewer', false, false], ['admin', true, false], ['owner', true, true]] as const) {
      document.body.innerHTML = '';
      const root = settingsShell();
      installPrivacyTab(root, { apiFetch: memberApi(role).fn, navigate: vi.fn() });
      $(root, 'tab-privacy').click();
      await flush();
      expect($(root, 'org-export-wrap').hidden, `${role} export`).toBe(!orgExport);
      expect($(root, 'delete-org-card').hidden, `${role} delete`).toBe(!orgDelete);
      expect($(root, 'delete-account-card').hidden).toBe(false);
    }
  });

  it('downloads the export blob with the server filename and flags a truncated archive', async () => {
    const root = settingsShell();
    const download = vi.fn();
    const blob = new Blob(['{"meta":{},"truncated":true}']);
    const apiFetchBlob = vi.fn(async () => ({ blob, filename: 'pinpoint-my-data-2026-11-27.json' }));
    installPrivacyTab(root, { apiFetch: memberApi('member').fn, apiFetchBlob: apiFetchBlob as never, download, navigate: vi.fn() });
    $(root, 'tab-privacy').click();
    await flush();
    $(root, 'export-mine').click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(apiFetchBlob).toHaveBeenCalledWith('/privacy/export');
    expect(download).toHaveBeenCalledWith(blob, 'pinpoint-my-data-2026-11-27.json');
    await vi.waitFor(() => expect($(root, 'privacy-status').textContent).toMatch(/"truncated": true/));
  });

  it('shows export errors inline and re-enables the button', async () => {
    const root = settingsShell();
    const apiFetchBlob = vi.fn(async () => { throw new ApiError('Nope', 'FORBIDDEN', 403); });
    installPrivacyTab(root, { apiFetch: memberApi('admin').fn, apiFetchBlob: apiFetchBlob as never, download: vi.fn(), navigate: vi.fn() });
    $(root, 'tab-privacy').click();
    await flush();
    const btn = $(root, 'export-org') as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => expect($(root, 'privacy-status').textContent).toBe('Nope'));
    expect($(root, 'privacy-status').getAttribute('role')).toBe('status');
    expect(btn.disabled).toBe(false);
    expect(apiFetchBlob).toHaveBeenCalledWith('/privacy/org-export');
  });

  it('account deletion needs TWO steps (reveal, then password + acknowledgement) before anything is sent', async () => {
    const root = settingsShell();
    const navigate = vi.fn();
    const api = fakeApi({
      'GET /users/me': () => ({ user: { id: 'u1' } }),
      'GET /org/members': () => ({ data: [{ userId: 'u1', role: 'member' }] }),
      'DELETE /privacy/account': () => ({ deleted: true }),
    });
    installPrivacyTab(root, { apiFetch: api.fn, navigate });
    $(root, 'tab-privacy').click();
    await flush();

    const panel = $(root, 'delete-account-panel');
    const confirm = $(root, 'delete-account-confirm') as HTMLButtonElement;
    expect(panel.hidden).toBe(true);
    $(root, 'delete-account-start').click();
    expect(panel.hidden).toBe(false);
    expect(confirm.disabled).toBe(true);

    ($(root, 'delete-account-password') as HTMLInputElement).value = 'Correct-Horse-9!';
    $(root, 'delete-account-password').dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(true); // still needs the acknowledgement
    const ack = $(root, 'delete-account-ack') as HTMLInputElement;
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    expect(confirm.disabled).toBe(false);
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);

    confirm.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth'));
    const del = api.calls.find((c) => c.method === 'DELETE')!;
    expect(del.path).toBe('/privacy/account');
    expect(del.body).toEqual({ password: 'Correct-Horse-9!', confirmEmail: 'Correct-Horse-9!' });
    expect(getCsrfToken()).toBeNull(); // local auth state dropped
  });

  it('surfaces the server error (e.g. sole owner) inline and stays on the page', async () => {
    const root = settingsShell();
    const navigate = vi.fn();
    const api = fakeApi({
      'GET /users/me': () => ({ user: { id: 'u1' } }),
      'GET /org/members': () => ({ data: [{ userId: 'u1', role: 'member' }] }),
      'DELETE /privacy/account': () => { throw new ApiError('Transfer ownership first.', 'SOLE_OWNER', 409); },
    });
    installPrivacyTab(root, { apiFetch: api.fn, navigate });
    $(root, 'tab-privacy').click();
    await flush();
    $(root, 'delete-account-start').click();
    ($(root, 'delete-account-password') as HTMLInputElement).value = 'pw';
    $(root, 'delete-account-password').dispatchEvent(new Event('input'));
    const ack = $(root, 'delete-account-ack') as HTMLInputElement;
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    $(root, 'delete-account-confirm').click();
    await vi.waitFor(() => expect($(root, 'delete-account-error').hidden).toBe(false));
    expect($(root, 'delete-account-error').textContent).toBe('Transfer ownership first.');
    expect(navigate).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBe('t');
    // Cancel resets everything.
    $(root, 'delete-account-cancel').click();
    expect($(root, 'delete-account-panel').hidden).toBe(true);
    expect(($(root, 'delete-account-password') as HTMLInputElement).value).toBe('');
  });

  it('organisation deletion also requires typing the organisation name', async () => {
    const root = settingsShell();
    const navigate = vi.fn();
    const api = fakeApi({
      'GET /users/me': () => ({ id: 'u1' }),
      'GET /org/members': () => ({ data: [{ userId: 'u1', role: 'owner' }] }),
      'GET /org': () => ({ org: { name: 'Acme <b>Inc</b>' } }),
      'DELETE /privacy/org': () => ({ deleted: true }),
    });
    installPrivacyTab(root, { apiFetch: api.fn, navigate });
    $(root, 'tab-privacy').click();
    await flush();
    $(root, 'delete-org-start').click();
    const confirm = $(root, 'delete-org-confirm') as HTMLButtonElement;
    ($(root, 'delete-org-password') as HTMLInputElement).value = 'pw';
    $(root, 'delete-org-password').dispatchEvent(new Event('input'));
    const ack = $(root, 'delete-org-ack') as HTMLInputElement;
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    expect(confirm.disabled).toBe(true); // name still empty
    const name = $(root, 'delete-org-name') as HTMLInputElement;
    name.value = 'Acme <b>Inc</b>';
    name.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth'));
    expect(api.calls.find((c) => c.method === 'DELETE')!.body).toEqual({ password: 'pw', confirmEmail: 'pw', confirmName: 'Acme <b>Inc</b>' });
    // Hostile organisation names are text, never markup.
    expect(document.body.querySelector('b')).toBeNull();
  });

  it('returns null (no crash) when the Settings shell has no tab bar', () => {
    const bare = document.createElement('div');
    expect(installPrivacyTab(bare, {})).toBeNull();
  });

  it('is built without innerHTML sinks', () => {
    expect(privacySource).not.toMatch(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/);
  });
});
