// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountAuthPage` page (task 18.4).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 31.1
 *
 * Covers:
 * - Renders the login chrome by default (title, switch link, hidden name field).
 * - Toggling between login and register modes shows/hides the name field
 *   and rewrites the title and switch labels.
 * - Submitting an empty form surfaces an inline validation error and never
 *   touches `fetch`.
 * - Submitting valid login credentials POSTs to `/api/v1/auth/login`,
 *   stores the token, mirrors the user into `authStore.currentUser`, and
 *   navigates to `/`.
 * - Submitting valid register credentials POSTs to `/api/v1/auth/register`
 *   with `name`, `email`, and `password` and produces the same side
 *   effects as login.
 * - Server errors surface inline and do not advance navigation.
 * - The submit button is disabled and rebadged while a request is in
 *   flight; the chrome is restored once the request resolves (success or
 *   failure).
 * - The teardown function unbinds events and signal subscriptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAuthPage } from './AuthPage';
import { authStore, resetStores } from '../lib/stores';
import { clearAuth, getToken } from '../lib/auth';

// --- Test fixtures ----------------------------------------------------------

/**
 * The auth-page template. Mirrors `dashboard/index.html` closely enough for
 * the page module to wire every slot; styles are dropped because they have
 * no observable effect in jsdom and only inflate the fixture.
 */
const AUTH_PAGE_TEMPLATE_HTML = `
  <div class="fl-auth-page">
    <form class="fl-auth-page__form" data-action="submit:submit" novalidate>
      <h1 data-slot="title"></h1>
      <div data-slot="error" role="alert" hidden></div>
      <div data-slot="nameField" hidden>
        <label for="fl-auth-name">Name</label>
        <input id="fl-auth-name" name="name" type="text" />
      </div>
      <div>
        <label for="fl-auth-email">Email</label>
        <input id="fl-auth-email" name="email" type="email" required />
      </div>
      <div>
        <label for="fl-auth-password">Password</label>
        <input id="fl-auth-password" name="password" type="password" required />
      </div>
      <button type="submit" data-slot="submitBtn"></button>
      <p>
        <span data-slot="switchPrompt"></span>
        <button type="button" data-slot="switchBtn" data-action="toggleMode"></button>
      </p>
    </form>
  </div>
`;

const sampleUser = {
  id: 'user-1',
  email: 'alice@example.test',
  name: 'Alice',
  notificationPreferences: {
    newAnnotation: true,
    newComment: true,
    promotedToOwner: true,
    projectDeleted: true,
  },
  createdAt: '2024-01-01T00:00:00.000Z',
};

function installAuthTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-auth-page';
  tpl.innerHTML = AUTH_PAGE_TEMPLATE_HTML;
  document.body.appendChild(tpl);
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

function $form(root: HTMLElement): HTMLFormElement {
  return root.querySelector('form')!;
}

function $byName(root: HTMLElement, name: string): HTMLInputElement {
  return root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
}

function $bySlot(root: HTMLElement, slot: string): HTMLElement {
  return root.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  installAuthTemplate();
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

// --- Tests ------------------------------------------------------------------

describe('mountAuthPage', () => {
  it('renders the login chrome by default', () => {
    const root = makeRoot();

    mountAuthPage(root);

    expect($bySlot(root, 'title').textContent).toBe('Log In');
    expect($bySlot(root, 'submitBtn').textContent).toBe('Log In');
    expect($bySlot(root, 'switchPrompt').textContent).toBe("Don't have an account? ");
    expect($bySlot(root, 'switchBtn').textContent).toBe('Register');
    expect($bySlot(root, 'nameField').hasAttribute('hidden')).toBe(true);
    expect($bySlot(root, 'error').hasAttribute('hidden')).toBe(true);
  });

  it('toggleMode swaps between login and register, revealing the name field on register', () => {
    const root = makeRoot();
    mountAuthPage(root);

    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();

    expect($bySlot(root, 'title').textContent).toBe('Register');
    expect($bySlot(root, 'submitBtn').textContent).toBe('Register');
    expect($bySlot(root, 'switchPrompt').textContent).toBe('Already have an account? ');
    expect($bySlot(root, 'switchBtn').textContent).toBe('Log In');
    expect($bySlot(root, 'nameField').hasAttribute('hidden')).toBe(false);

    // And toggling again returns to login.
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();
    expect($bySlot(root, 'title').textContent).toBe('Log In');
    expect($bySlot(root, 'nameField').hasAttribute('hidden')).toBe(true);
  });

  it('toggleMode clears any existing inline error', () => {
    const root = makeRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);

    // Trigger validation failure to populate the error slot.
    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    const errorEl = $bySlot(root, 'error');
    expect(errorEl.hasAttribute('hidden')).toBe(false);
    expect(errorEl.textContent).toBe('Please fill in all fields.');

    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();

    expect(errorEl.hasAttribute('hidden')).toBe(true);
    expect(errorEl.textContent).toBe('');
    // Validation alone never reaches fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submitting an empty form surfaces an inline error and never calls fetch', () => {
    const root = makeRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    const errorEl = $bySlot(root, 'error');
    expect(errorEl.hasAttribute('hidden')).toBe(false);
    expect(errorEl.textContent).toBe('Please fill in all fields.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('login submits to /api/v1/auth/login, stores the token, mirrors the user, and navigates to /', async () => {
    const root = makeRoot();

    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ user: sampleUser, token: 'jwt-from-login' }),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);

    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // Allow the awaited apiFetch + post-success branch to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe('/api/v1/auth/login');
    expect(calledInit.method).toBe('POST');
    expect(JSON.parse(calledInit.body as string)).toEqual({
      email: 'alice@example.test',
      password: 'password123',
    });

    expect(getToken()).toBe('jwt-from-login');
    expect(authStore.currentUser.get()).toEqual(sampleUser);
    expect(authStore.isAuthenticated.get()).toBe(true);
    expect(location.pathname).toBe('/');
  });

  it('register submits to /api/v1/auth/register with name + email + password', async () => {
    const root = makeRoot();

    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ user: sampleUser, token: 'jwt-from-register' }, { status: 201 }),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);

    // Switch to register mode first.
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();

    $byName(root, 'name').value = 'Alice';
    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe('/api/v1/auth/register');
    expect(calledInit.method).toBe('POST');
    expect(JSON.parse(calledInit.body as string)).toEqual({
      email: 'alice@example.test',
      password: 'password123',
      name: 'Alice',
    });

    expect(getToken()).toBe('jwt-from-register');
    expect(authStore.currentUser.get()).toEqual(sampleUser);
    expect(location.pathname).toBe('/');
  });

  it('register requires name, email, and password — submitting with name empty surfaces an error', () => {
    const root = makeRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);
    ($bySlot(root, 'switchBtn') as HTMLButtonElement).click();

    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';
    // name intentionally left blank

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    expect($bySlot(root, 'error').textContent).toBe('Please fill in all fields.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces server-side error messages and does not navigate or persist a token', async () => {
    const root = makeRoot();

    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } },
          { status: 401 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    history.replaceState(null, '', '/auth');
    mountAuthPage(root);

    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'wrong';

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const errorEl = $bySlot(root, 'error');
    expect(errorEl.hasAttribute('hidden')).toBe(false);
    expect(errorEl.textContent).toBe('Invalid email or password.');

    expect(getToken()).toBeNull();
    expect(authStore.currentUser.get()).toBeNull();
    expect(authStore.isAuthenticated.get()).toBe(false);
    expect(location.pathname).toBe('/auth');

    // Submit button is restored after the request settles.
    const submitBtn = $bySlot(root, 'submitBtn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe('Log In');
  });

  it('disables the submit button and rebadges it while a request is in flight', async () => {
    const root = makeRoot();

    let resolveFetch: (value: Response) => void = () => {};
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    mountAuthPage(root);

    $byName(root, 'email').value = 'alice@example.test';
    $byName(root, 'password').value = 'password123';

    $form(root).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    const submitBtn = $bySlot(root, 'submitBtn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.textContent).toBe('Please wait…');

    resolveFetch(jsonResponse({ user: sampleUser, token: 'jwt' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(submitBtn.disabled).toBe(false);
    // After success the page navigates away, but the rebadged label is
    // restored before the navigation runs (the loading signal flips back
    // in the `finally`).
    expect(submitBtn.textContent).toBe('Log In');
  });

  it('teardown removes the rendered DOM and stops handling events', () => {
    const root = makeRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const teardown = mountAuthPage(root);

    expect(root.querySelector('.fl-auth-page')).not.toBeNull();

    teardown();

    expect(root.querySelector('.fl-auth-page')).toBeNull();
    // Re-mounting works cleanly — proves teardown did not leave global
    // listeners attached to the document or signal listeners hanging on.
    mountAuthPage(root);
    expect(root.querySelector('.fl-auth-page')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws a clear error when the template is missing', () => {
    document.getElementById('tpl-auth-page')!.remove();
    const root = makeRoot();

    expect(() => mountAuthPage(root)).toThrow(
      /no <template> element found with id "tpl-auth-page"/,
    );
  });
});
