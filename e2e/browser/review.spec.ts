/**
 * Real-UI: review link page (f).
 *
 * `/review/:linkId` (ReviewLinkPage.ts) frames the server-side proxy of the
 * project's target page inside a sandboxed iframe, alongside a sidebar that
 * explains the flow. The proxy fetches the target through the SSRF egress
 * guard; if egress fails (offline CI, blocked host) the page shows a clean
 * error state rather than proxied content.
 *
 * This spec asserts the SHELL renders (heading + iframe + a settled status),
 * tolerating either the "loaded" or the clean-error status so it passes with
 * or without outbound network access.
 */
import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  createProject,
  createSharedLink,
  deleteProject,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

test.describe('review link page', () => {
  let api: ApiClient | null;
  const toCleanup: CreatedProject[] = [];

  test.beforeAll(async () => {
    api = await makeApiClient();
  });

  test.afterEach(async () => {
    if (!api) return;
    while (toCleanup.length) {
      const p = toCleanup.pop()!;
      await deleteProject(api, p).catch(() => {});
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('(f) renders the frame shell and a settled status', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `browser-review-${uniqueSuffix()}`;
    // Password-less, feedback-enabled link so it is proxyable.
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);
    const link = await createSharedLink(api!, project.id, { allowFeedback: true });

    await page.goto(`/review/${link.id}`);

    const root = page.locator('[data-fl-review-root]');
    await expect(root).toBeVisible({ timeout: 15_000 });

    // Sidebar heading + honest-limitations notice are part of the shell.
    await expect(page.getByRole('heading', { name: 'Review link' })).toBeVisible();

    // The iframe is always present (its content may or may not load).
    const frame = root.locator('iframe[title="Reviewed page"]');
    await expect(frame).toHaveCount(1);

    // The status slot settles to a non-empty message — either the loaded
    // message or the clean error state. Both are acceptable; we just require
    // it is not stuck blank.
    const status = root.locator('[data-slot="status"]');
    await expect
      .poll(async () => (await status.textContent())?.trim() ?? '', { timeout: 15_000 })
      .not.toBe('');
  });

  test('(f2) iframe sandbox omits allow-same-origin and the frame is an opaque origin', async ({ page }) => {
    // An unknown link id makes the proxy answer with its 404 error page, so
    // this needs no outbound network and no seeded data.
    await page.goto('/review/does-not-exist-sandbox-check');
    const iframe = page.locator('iframe[title="Reviewed page"]');
    await expect(iframe).toHaveCount(1);

    // Layer (a): the sandbox attribute.
    const tokens = ((await iframe.getAttribute('sandbox')) ?? '').split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups']));
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-top-navigation');

    // Wait for the frame to settle on the proxied (error) document.
    await expect
      .poll(() => page.frames().some((f) => f.url().includes('/review/does-not-exist-sandbox-check/frame')), {
        timeout: 15_000,
      })
      .toBe(true);

    // Behavioural proof: the parent cannot touch the frame's document.
    const result = await page.evaluate(() => {
      const el = document.querySelector('iframe[title="Reviewed page"]') as HTMLIFrameElement;
      try {
        void el.contentWindow!.document;
        return { threw: false, name: '' };
      } catch (e) {
        return { threw: true, name: (e as Error).name };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.name).toBe('SecurityError');
  });

  test('(f3) the proxy response alone forces an opaque origin (CSP sandbox, direct navigation)', async ({ page }) => {
    // Layer (b): even when navigated to directly (no iframe sandbox), the
    // CSP `sandbox` directive must put the document in an opaque origin, so
    // nothing in it can act as the dashboard origin.
    const res = await page.goto('/review/does-not-exist-sandbox-check/frame');
    expect(res).not.toBeNull();
    const csp = res!.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/sandbox allow-scripts allow-forms allow-popups/);
    expect(csp).not.toContain('allow-same-origin');
    const origin = await page.evaluate(() => window.origin);
    expect(origin).toBe('null');
    // Cookies of the app origin are not readable from the opaque origin.
    const cookieAccess = await page.evaluate(() => {
      try {
        return document.cookie === '' ? 'empty' : 'readable';
      } catch {
        return 'threw';
      }
    });
    expect(['empty', 'threw']).toContain(cookieAccess);
  });
});
