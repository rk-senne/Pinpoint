// @vitest-environment jsdom
/**
 * ResetPasswordPage.test.ts — regression: the emailed `/reset-password/:token`
 * link and the "Forgot password?" entry point had no dashboard page at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetLazyTemplatesForTests } from '../lib/lazyTemplates';
import { mountResetPasswordPage } from './ResetPasswordPage';

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];

function stub(status = 200, body: unknown = { message: 'ok' }): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mountPage(params?: Record<string, string>): { root: HTMLElement; teardown: () => void } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const teardown = mountResetPasswordPage(root, params);
  return { root, teardown };
}

afterEach(() => {
  document.body.replaceChildren();
  _resetLazyTemplatesForTests();
  vi.unstubAllGlobals();
});

describe('ResetPasswordPage', () => {
  it('request mode posts the email and shows the generic confirmation', async () => {
    stub();
    const { root } = mountPage();
    (root.querySelector('input[name="email"]') as HTMLInputElement).value = 'a@example.test';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(calls[0]).toMatchObject({ method: 'POST', body: { email: 'a@example.test' } });
    expect(calls[0]!.url).toMatch(/\/auth\/reset-password$/);
    expect(root.querySelector('[data-slot="message"]')!.textContent).toMatch(/reset link has been sent/);
  });

  it('token mode posts the new password to the token endpoint', async () => {
    stub();
    const { root } = mountPage({ token: 'abc123' });
    expect(root.querySelector('[data-slot="passwordField"]')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-slot="emailField"]')!.hasAttribute('hidden')).toBe(true);
    (root.querySelector('input[name="password"]') as HTMLInputElement).value = 'Brand-new-pass-77!';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(calls[0]!.url).toMatch(/\/auth\/reset-password\/abc123$/);
    expect(calls[0]!.body).toEqual({ password: 'Brand-new-pass-77!' });
  });

  it('surfaces a server rejection as an alert', async () => {
    stub(400, { error: { code: 'INVALID_TOKEN', message: 'Reset link is invalid or expired.' } });
    const { root } = mountPage({ token: 'bad' });
    (root.querySelector('input[name="password"]') as HTMLInputElement).value = 'Brand-new-pass-77!';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const msg = root.querySelector('[data-slot="message"]')!;
    expect(msg.getAttribute('role')).toBe('alert');
    expect(msg.textContent).toMatch(/invalid or expired/);
  });
});
