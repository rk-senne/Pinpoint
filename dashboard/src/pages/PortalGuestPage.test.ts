// @vitest-environment jsdom
/**
 * PortalGuestPage.test.ts — the guest `/portal/:slug` page: branding, magic-link
 * token handling (scrubbed from the URL, sent as a Bearer, never as a cookie),
 * expired/missing-token access request, not-found, XSS-inert rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPortalGuestPage, safeBrandColor, safeLogoUrl } from './PortalGuestPage';
import { _resetLazyTemplatesForTests } from '../lib/lazyTemplates';

interface Call { method: string; url: string; headers: Record<string, string>; credentials?: RequestCredentials; body?: unknown }
let calls: Call[];

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const INFO = {
  portal: { id: 'p1', title: 'Acme Review', welcomeMessage: 'Hello\nthere', brandColor: '#112233', logoUrl: 'https://cdn.test/logo.png', allowNewFeedback: true, requireEmail: true },
};
const XSS = '<img src=x onerror=alert(1)>';

function stub(opts: { info?: Response; feedback?: Response; access?: Response } = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        credentials: init?.credentials,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/info')) return Promise.resolve(opts.info ?? json(INFO));
      if (url.endsWith('/feedback')) return Promise.resolve(opts.feedback ?? json({ feedback: [] }));
      if (url.endsWith('/access')) return Promise.resolve(opts.access ?? json({ message: "If that email is on the portal you'll receive a link." }, 202));
      return Promise.resolve(json({}, 404));
    }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function mountAt(url: string, slug = 'acme'): { root: HTMLElement; teardown: () => void } {
  history.replaceState(null, '', url);
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, teardown: mountPortalGuestPage(root, { slug }) };
}

const q = <T extends HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;
const visible = (root: ParentNode, section: string): boolean => !q(root, `[data-section="${section}"]`).hidden;

beforeEach(() => {
  document.body.innerHTML = '';
  _resetLazyTemplatesForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('PortalGuestPage', () => {
  it('shows branding and the feedback list when the magic-link token is valid', async () => {
    stub({
      feedback: json({
        feedback: [
          { id: 'a1', pinNumber: 3, type: 'note', severity: 'major', status: 'active', body: XSS, createdAt: '2026-11-01T10:00:00.000Z', pageUrl: 'https://acme.test/pricing' },
        ],
      }),
    });
    const { root, teardown } = mountAt('/portal/acme?token=abc123&x=1');
    await flush();

    expect(q(root, '[data-slot="title"]').textContent).toBe('Acme Review');
    expect(q(root, '[data-fl-portal-root]').style.getPropertyValue('--portal-brand')).toBe('#112233');
    expect((q(root, '[data-slot="logo"]') as HTMLImageElement).src).toBe('https://cdn.test/logo.png');
    expect(q(root, '[data-slot="welcome"]').textContent).toBe('Hello\nthere');
    expect(visible(root, 'feedback')).toBe(true);
    const row = q(root, '[data-role="portal-feedback"]');
    expect(row.querySelector('img')).toBeNull(); // XSS inert
    expect(row.textContent).toContain(XSS);
    expect(row.textContent).toContain('#3');

    const fb = calls.find((c) => c.url.endsWith('/feedback'))!;
    expect(fb.headers.Authorization).toBe('Bearer abc123');
    expect(fb.credentials).toBe('omit');
    teardown();
  });

  it('hides the logo instead of a broken image when it cannot load (e.g. blocked by CSP)', async () => {
    stub({ feedback: json({ feedback: [] }) });
    const { root, teardown } = mountAt('/portal/acme?token=abc123');
    await flush();
    const logo = q<HTMLImageElement>(root, '[data-slot="logo"]');
    expect(logo.hidden).toBe(false);
    expect(logo.referrerPolicy).toBe('no-referrer');
    logo.dispatchEvent(new Event('error'));
    expect(logo.hidden).toBe(true);
    teardown();
  });

  it('removes the token from the address bar but keeps other query params', async () => {
    stub();
    const { teardown } = mountAt('/portal/acme?token=secret&keep=1');
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.href).not.toContain('secret');
    await flush();
    teardown();
  });

  it('without a token it offers the access form, and posts the email credential-less', async () => {
    stub();
    const { root, teardown } = mountAt('/portal/acme');
    await flush();
    expect(visible(root, 'access')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/feedback'))).toBe(false);

    q<HTMLInputElement>(root, '[data-slot="email"]').value = 'guest@client.test';
    q<HTMLFormElement>(root, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/portals/acme/access');
    expect(post.body).toEqual({ email: 'guest@client.test' });
    expect(post.credentials).toBe('omit');
    expect(q(root, '[data-slot="access-sent"]').hidden).toBe(false);
    teardown();
  });

  it('rejects an invalid email client-side without calling the API', async () => {
    stub();
    const { root, teardown } = mountAt('/portal/acme');
    await flush();
    q<HTMLInputElement>(root, '[data-slot="email"]').value = 'nope';
    q<HTMLFormElement>(root, 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(q(root, '[data-slot="access-error"]').hidden).toBe(false);
    teardown();
  });

  it('an expired token falls back to the access form with an "expired" message', async () => {
    stub({ feedback: json({ error: { code: 'UNAUTHORIZED' } }, 401) });
    const { root, teardown } = mountAt('/portal/acme?token=old');
    await flush();
    expect(visible(root, 'access')).toBe(true);
    expect(q(root, '[data-slot="access-title"]').textContent).toMatch(/expired/i);
    teardown();
  });

  it('shows not-found for an unknown or inactive portal and never asks for feedback', async () => {
    stub({ info: json({ error: { code: 'NOT_FOUND' } }, 404) });
    const { root, teardown } = mountAt('/portal/ghost?token=abc', 'ghost');
    await flush();
    expect(visible(root, 'not_found')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/feedback'))).toBe(false);
    teardown();
  });

  it('ignores unsafe branding values', async () => {
    stub({ info: json({ portal: { title: XSS, brandColor: 'red;background:url(x)', logoUrl: 'javascript:alert(1)' } }) });
    const { root, teardown } = mountAt('/portal/acme');
    await flush();
    expect(q(root, '[data-slot="title"]').querySelector('img')).toBeNull();
    expect(q(root, '[data-slot="title"]').textContent).toBe(XSS);
    expect(q(root, '[data-fl-portal-root]').style.getPropertyValue('--portal-brand')).toBe('');
    expect(q<HTMLImageElement>(root, '[data-slot="logo"]').hidden).toBe(true);
    teardown();
  });

  it('safeBrandColor / safeLogoUrl accept only #rrggbb and http(s)', () => {
    expect(safeBrandColor('#AaBbCc')).toBe('#AaBbCc');
    for (const bad of ['#abc', 'red', '#12345g', 'url(x)', null, 5]) expect(safeBrandColor(bad)).toBeNull();
    expect(safeLogoUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://x', '', null]) expect(safeLogoUrl(bad)).toBeNull();
  });
});
