// @vitest-environment jsdom
/**
 * Registration terms acceptance (GDPR Art. 7(1) / POPIA s.11) on the AuthPage:
 * the "I agree to the Terms and Privacy Policy" checkbox is required, never
 * pre-ticked, only shown in register mode, links to the legal pages, and the
 * request carries `acceptTerms: true`.
 *
 * Self-contained fixture (own copy of the auth template) so this file does not
 * depend on how the main AuthPage fixture evolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAuthPage } from './AuthPage';
import { resetStores } from '../lib/stores';
import { clearAuth } from '../lib/auth';

const TEMPLATE = `
  <div class="fl-auth-page">
    <form class="fl-auth-page__form" data-action="submit:submit" novalidate>
      <h1 data-slot="title"></h1>
      <div data-slot="error" role="alert" hidden></div>
      <div data-slot="nameField" hidden><input id="fl-auth-name" name="name" type="text" /></div>
      <div class="fl-auth-page__field"><input id="fl-auth-email" name="email" type="email" /></div>
      <div class="fl-auth-page__field"><input id="fl-auth-password" name="password" type="password" /></div>
      <div data-slot="mfaField" hidden><input id="fl-auth-code" name="code" type="text" /></div>
      <button type="submit" data-slot="submitBtn"></button>
      <p><span data-slot="switchPrompt"></span><button type="button" data-slot="switchBtn" data-action="toggleMode"></button></p>
      <p data-slot="forgotRow"></p>
    </form>
  </div>
`;

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}
const $byName = (root: HTMLElement, name: string): HTMLInputElement => root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
const $bySlot = (root: HTMLElement, slot: string): HTMLElement => root.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
const submit = (root: HTMLElement): void => {
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = '';
  const tpl = document.createElement('template');
  tpl.id = 'tpl-auth-page';
  tpl.innerHTML = TEMPLATE;
  document.body.appendChild(tpl);
  resetStores();
  clearAuth();
  history.replaceState(null, '', '/auth');
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetStores();
  clearAuth();
  history.replaceState(null, '', '/');
});

describe('AuthPage — terms acceptance', () => {
  it('register is blocked until the Terms/Privacy checkbox is ticked, and the checkbox only shows in register mode', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mountAuthPage(root);

    const row = root.querySelector('[data-slot="termsConsent"]') as HTMLElement;
    const box = root.querySelector('input[name="acceptTerms"]') as HTMLInputElement;
    expect(row.hidden).toBe(true); // login mode
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();
    expect(row.hidden).toBe(false);
    expect(box.checked).toBe(false); // never pre-ticked
    expect(box.required).toBe(true);
    const links = [...row.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/legal/terms', '/legal/privacy']);

    $byName(root, 'name').value = 'Alice';
    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';
    submit(root);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
    const err = root.querySelector('#fl-auth-terms-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/agree to the Terms of Service and Privacy Policy/);
    expect(box.getAttribute('aria-invalid')).toBe('true');

    // Back to login hides and resets it.
    box.checked = true;
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();
    expect(row.hidden).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('sends acceptTerms: true once ticked', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ user: { id: 'u' } }), { status: 201, headers: { 'Content-Type': 'application/json' } })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    mountAuthPage(root);
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();
    $byName(root, 'name').value = 'Alice';
    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';
    $byName(root, 'acceptTerms').checked = true;
    submit(root);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/register');
    expect(JSON.parse(init.body as string)).toMatchObject({ acceptTerms: true, email: 'alice@example.test' });
  });

  it('login requests never carry acceptTerms', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'no' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    mountAuthPage(root);
    $byName(root, 'email').value = 'a@b.test';
    $byName(root, 'password').value = 'password123';
    submit(root);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('acceptTerms');
  });
});
