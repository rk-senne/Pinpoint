// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSecret, mountTwoFactorPanel } from './TwoFactorPanel';

type Call = [string, { method?: string; body?: string } | undefined];

function makeApi(handlers: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push([path, init]);
    const key = `${init?.method ?? 'GET'} ${path}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected ${key}`);
    return h(init?.body ? JSON.parse(init.body) : undefined);
  });
  return { api: api as never, calls };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const q = <T extends HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('formatSecret', () => {
  it('groups the key in fours', () => {
    expect(formatSecret('ABCDEFGHIJKL')).toBe('ABCD EFGH IJKL');
  });
});

describe('TwoFactorPanel', () => {
  it('walks enroll → verify → recovery codes (shown once) → enabled', async () => {
    let enabled = false;
    const { api, calls } = makeApi({
      'GET /auth/mfa': () => ({ enabled, recoveryCodesRemaining: enabled ? 10 : 0 }),
      'POST /auth/mfa/enroll': () => ({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' }),
      'POST /auth/mfa/verify': () => {
        enabled = true;
        return { recoveryCodes: Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBB${i}`) };
      },
    });
    mountTwoFactorPanel(host, { apiFetch: api });
    await settle();
    q<HTMLButtonElement>(host, '[data-role="mfa-start"]').click();

    const pw = q<HTMLInputElement>(host, 'input[name="password"]');
    expect(pw.getAttribute('autocomplete')).toBe('current-password');
    pw.value = 'my-password-1';
    q<HTMLFormElement>(host, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();
    expect(JSON.parse(calls.find(([p]) => p === '/auth/mfa/enroll')![1]!.body!)).toEqual({ password: 'my-password-1' });
    expect(q(host, '[data-role="mfa-secret"]').textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');

    const code = q<HTMLInputElement>(host, 'input[name="code"]');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    code.value = '12ab56';
    q<HTMLFormElement>(host, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();
    expect(calls.some(([p]) => p === '/auth/mfa/verify')).toBe(false); // malformed code never sent
    expect(host.textContent).toContain('Enter the 6-digit code.');

    code.value = '123456';
    q<HTMLFormElement>(host, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();
    const codes = host.querySelectorAll('[data-role="mfa-recovery-codes"] li');
    expect(codes).toHaveLength(10);

    // Dismissing drops the codes from the DOM and shows the enabled state.
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'I have saved them')!.click();
    await settle();
    expect(host.querySelector('[data-role="mfa-recovery-codes"]')).toBeNull();
    expect(host.textContent).toContain('Two-factor authentication is ON. 10 recovery codes remaining.');
  });

  it('shows the server error and re-enables the button when the password is wrong', async () => {
    const { api } = makeApi({
      'GET /auth/mfa': () => ({ enabled: false, recoveryCodesRemaining: 0 }),
      'POST /auth/mfa/enroll': () => {
        throw new Error('Current password is incorrect.');
      },
    });
    mountTwoFactorPanel(host, { apiFetch: api });
    await settle();
    q<HTMLButtonElement>(host, '[data-role="mfa-start"]').click();
    q<HTMLInputElement>(host, 'input[name="password"]').value = 'wrong';
    q<HTMLFormElement>(host, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();
    const alert = host.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toBe('Current password is incorrect.');
    expect(alert.hidden).toBe(false);
    expect(q<HTMLButtonElement>(host, 'button[type="submit"]').disabled).toBe(false);
  });

  it('disable asks for password + code and posts both', async () => {
    let enabled = true;
    const { api, calls } = makeApi({
      'GET /auth/mfa': () => ({ enabled, recoveryCodesRemaining: 7 }),
      'POST /auth/mfa/disable': () => {
        enabled = false;
        return undefined;
      },
    });
    mountTwoFactorPanel(host, { apiFetch: api });
    await settle();
    expect(host.textContent).toContain('7 recovery codes remaining');
    q<HTMLButtonElement>(host, '[data-role="mfa-disable"]').click();
    q<HTMLInputElement>(host, 'input[name="password"]').value = 'pw-1234567';
    q<HTMLInputElement>(host, 'input[name="code"]').value = '654321';
    q<HTMLFormElement>(host, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();
    expect(JSON.parse(calls.find(([p]) => p === '/auth/mfa/disable')![1]!.body!)).toEqual({ password: 'pw-1234567', code: '654321' });
    expect(q(host, '[data-role="mfa-start"]')).not.toBeNull();
  });

  it('renders untrusted server text as text, never markup', async () => {
    const { api } = makeApi({
      'GET /auth/mfa': () => {
        throw new Error('<img src=x onerror=alert(1)>');
      },
    });
    mountTwoFactorPanel(host, { apiFetch: api });
    await settle();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('dispose removes the panel', async () => {
    const { api } = makeApi({ 'GET /auth/mfa': () => ({ enabled: false, recoveryCodesRemaining: 0 }) });
    const dispose = mountTwoFactorPanel(host, { apiFetch: api });
    await settle();
    dispose();
    expect(host.querySelector('[data-role="two-factor-panel"]')).toBeNull();
  });
});
