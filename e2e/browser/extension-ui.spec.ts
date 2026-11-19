/**
 * Real-browser UI E2E for the Pinpoint Chrome Extension on a realistic
 * marketing landing page (header / nav / hero / pricing cards / footer).
 *
 * Runs in the `extension` Playwright project family: a PERSISTENT Chromium
 * context with the built MV3 bundle loaded (see extension.spec.ts for why).
 * Covers what extension.spec.ts does not: the click-to-annotate popover
 * (tabs, severity, body, submit), pin placement, captured diagnostics
 * (consoleLogs / jsErrors from the HOST page), the screenshot pipeline,
 * the comment thread with @mention autocomplete, resolve / reopen, the
 * sidebar, next/prev-pin commands, toolbar copy-link / close, offline
 * queueing + resync, realtime pins from another client, the popup (signed
 * out / signed in) and the options page (Server URL validation,
 * allow/block lists).
 *
 * Harness notes (things Playwright cannot do for real):
 *   - The toolbar icon / `chrome.commands` shortcuts can't be pressed, so
 *     the overlay is toggled with the same `TOGGLE_OVERLAY` runtime message
 *     the action handler sends, and Alt+Shift+S / . / , with the same
 *     `FL_COMMAND` message the service worker's `commands.onCommand`
 *     listener forwards.
 *   - A real toolbar click grants `activeTab`, which `captureVisibleTab`
 *     needs. That grant is simulated with an `<all_urls>` host permission
 *     in a THROWAWAY copy of `dist/` (`distWithActiveTabGrant`).
 *
 * Screenshots: docs/screenshots/extension-*.png.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Page, type Worker, chromium, expect, test } from '@playwright/test';

import { readSeedSession, uniqueSuffix } from './helpers.js';

const API_URL = process.env.FL_API_URL ?? 'http://localhost:3001';
const SHOTS = resolve(process.cwd(), '../docs/screenshots');
const PORT = 5431;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Minimal `chrome` surface used inside `serviceWorker.evaluate` callbacks. */
declare const chrome: {
  storage: {
    local: {
      set: (e: Record<string, unknown>) => Promise<void>;
      get: (k: string | null) => Promise<Record<string, unknown>>;
      remove: (k: string) => Promise<void>;
    };
    sync: {
      set: (e: Record<string, unknown>) => Promise<void>;
      get: (k: string | null) => Promise<Record<string, unknown>>;
      remove: (k: string[]) => Promise<void>;
    };
  };
  tabs: {
    query: (q: { url: string }) => Promise<Array<{ id?: number }>>;
    sendMessage: (id: number, m: unknown) => Promise<unknown>;
  };
};

/* ------------------------------------------------------------------ */
/* Harness helpers                                                     */
/* ------------------------------------------------------------------ */

const DIST = resolve(process.cwd(), '../extension/dist');

function landingPageHtml(title = 'Acme Cloud — Ship faster'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:Georgia,serif;color:#14213d;background:#fbfaf7}
  header{display:flex;justify-content:space-between;align-items:center;padding:18px 48px;background:#14213d;color:#fff}
  header .logo{font-weight:700;font-size:22px;letter-spacing:.5px}
  nav a{color:#fff;margin-left:24px;text-decoration:none;font-family:system-ui,sans-serif}
  .hero{padding:72px 48px 56px;text-align:center;background:linear-gradient(180deg,#e9eef8,#fbfaf7)}
  .hero h1{font-size:48px;margin:0 0 12px} .hero p{font-size:20px;color:#3d4b6b;margin:0 0 28px}
  .cta{background:#fca311;color:#14213d;border:0;border-radius:10px;padding:14px 28px;font-size:18px;font-weight:700;cursor:pointer}
  .pricing{display:flex;gap:24px;justify-content:center;padding:24px 48px 64px;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #dfe3ec;border-radius:14px;padding:28px;width:280px;box-shadow:0 2px 8px rgba(20,33,61,.06)}
  .card h3{margin:0 0 8px;font-size:24px} .price{font-size:36px;font-weight:700;margin:8px 0 16px}
  .card ul{padding-left:18px;color:#3d4b6b;line-height:1.7} .card button{width:100%;padding:12px;border-radius:8px;border:1px solid #14213d;background:#fff;font-size:16px;cursor:pointer}
  .card.featured{border:2px solid #fca311} .card.featured button{background:#14213d;color:#fff}
  footer{padding:32px 48px;background:#14213d;color:#c9d1e3;font-family:system-ui,sans-serif;font-size:14px;display:flex;justify-content:space-between}
  footer a{color:#c9d1e3}
</style>
</head>
<body>
<header><span class="logo" id="logo">Acme Cloud</span>
  <nav><a href="#features" id="nav-features">Features</a><a href="#pricing" id="nav-pricing">Pricing</a><a href="#docs" id="nav-docs">Docs</a><a href="#login" id="nav-login">Log in</a></nav>
</header>
<section class="hero" id="hero">
  <h1 id="hero-title">Ship faster with Acme Cloud</h1>
  <p id="hero-sub">Deploy, scale and observe your apps without touching a server.</p>
  <button class="cta" id="cta" onclick="window.__ctaClicks=(window.__ctaClicks||0)+1">Start free trial</button>
</section>
<section class="pricing" id="pricing">
  <div class="card" id="plan-starter"><h3>Starter</h3><div class="price">$0</div><ul><li>1 project</li><li>Community support</li></ul><button id="buy-starter">Choose Starter</button></div>
  <div class="card featured" id="plan-pro"><h3>Pro</h3><div class="price">$29</div><ul><li>Unlimited projects</li><li>Email support</li><li>Preview deploys</li></ul><button id="buy-pro">Choose Pro</button></div>
  <div class="card" id="plan-team"><h3>Team</h3><div class="price">$99</div><ul><li>SSO &amp; audit log</li><li>Priority support</li></ul><button id="buy-team">Choose Team</button></div>
</section>
<footer id="footer"><span>© 2026 Acme Cloud, Inc.</span><span><a href="#privacy">Privacy</a> · <a href="#terms">Terms</a></span></footer>
<script>
  // A realistic host-page error the annotation should carry as diagnostics.
  window.triggerHostError = function () {
    console.error('Pricing API failed: GET /api/prices 500');
  };
</script>
</body>
</html>`;
}

function startSite(port: number, html: string): Promise<http.Server> {
  return new Promise((res, rej) => {
    const server = http.createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      r.end(html);
    });
    server.on('error', rej);
    server.listen(port, '127.0.0.1', () => res(server));
  });
}

function closeSite(server: http.Server | null): Promise<void> {
  return new Promise((res) => (server ? server.close(() => res()) : res()));
}

async function launchExtension(extDir = DIST): Promise<{ ctx: BrowserContext; sw: Worker; extId: string }> {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    // Pin the FULL Chromium build: when this spec runs in a project whose
    // `launchOptions.executablePath` points at the headless shell (the
    // `browser` project), that build cannot run MV3 service workers.
    ...(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : {}),
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = sw.url().split('/')[2];
  return { ctx, sw, extId };
}

/** Send a runtime message to the tab whose URL starts with `url`. */
async function sendToTab(sw: Worker, url: string, message: unknown): Promise<void> {
  await sw.evaluate(
    async ({ u, m }) => {
      const [t] = await chrome.tabs.query({ url: `${u}*` });
      if (t?.id != null) await chrome.tabs.sendMessage(t.id, m);
    },
    { u: url, m: message },
  );
}

/** Same message the toolbar action handler sends. */
async function toggleOverlay(sw: Worker, url: string): Promise<void> {
  await sendToTab(sw, url, { type: 'TOGGLE_OVERLAY' });
}

/** Same message the SW's `commands.onCommand` listener forwards (Alt+Shift+S / . / ,). */
async function sendCommand(sw: Worker, url: string, command: string): Promise<void> {
  await sendToTab(sw, url, { type: 'FL_COMMAND', command });
}

/** Visible pins' numbers, in DOM order. */
async function readPins(page: Page): Promise<string[]> {
  return page.locator('fl-overlay-host fl-annotation-pin').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).style.display !== 'none')
      .map((e) => (e.shadowRoot?.querySelector('.pin-number')?.textContent ?? '').trim()),
  );
}

/**
 * Throwaway copy of `dist/` whose `host_permissions` include `<all_urls>`.
 *
 * Simulates the temporary `activeTab` grant a REAL toolbar click gives the
 * extension (Playwright cannot click the toolbar icon). `captureVisibleTab`
 * needs that grant; without it Chrome rejects with "Either the '<all_urls>'
 * or 'activeTab' permission is required". `content_scripts` are unchanged.
 */
function distWithActiveTabGrant(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pp-ext-ui-'));
  cpSync(DIST, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions ?? []), '<all_urls>'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

interface ApiAnnotation {
  id: string;
  type: string;
  severity: string;
  status: string;
  body: string;
  pinNumber: number;
  target: { cssSelector: string; tagName: string; textSnippet: string };
  environment: { browserFamily?: string; osFamily?: string; userAgentRaw?: string } | null;
  consoleLogs: Array<{ level: string; message: string }> | null;
  jsErrors: Array<{ kind: string; message: string; stack?: string }> | null;
  screenshotObjectKey?: string | null;
}

test.describe('Chrome Extension UI — landing page', () => {
  test.skip(!existsSync(DIST), 'extension/dist not found — run `npm run build --workspace extension`');
  const seed = readSeedSession();
  test.skip(!seed, 'Seed session unavailable (.auth/seed-session.json).');

  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  const auth = { Authorization: `Bearer ${seed?.body.token ?? ''}`, 'content-type': 'application/json' };
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${API_URL}/api/v1${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const listAnnotations = async (): Promise<ApiAnnotation[]> =>
    (await api<{ data: ApiAnnotation[] }>(`/projects/${projectId}/annotations?pageSize=100`)).data;

  let site: http.Server | null = null;
  let ctx: BrowserContext;
  let sw: Worker;
  let extId: string;
  let page: Page;
  let projectId = '';
  let projectName = '';
  /** Unique path → unique project mapping per run (by-url resolves the first match). */
  const PAGE_URL = `${ORIGIN}/acme-${uniqueSuffix()}`;

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    site = await startSite(PORT, landingPageHtml());
    projectName = `ext-ui-${uniqueSuffix()}`;
    const created = await api<{ project: { id: string } }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: projectName, urls: [PAGE_URL] }),
    });
    projectId = created.project.id;
    ({ ctx, sw, extId } = await launchExtension(distWithActiveTabGrant()));
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => {});
    await closeSite(site);
    if (projectId) {
      await fetch(`${API_URL}/api/v1/projects/${projectId}`, {
        method: 'DELETE',
        headers: auth,
        body: JSON.stringify({ confirmationToken: projectName }),
      }).catch(() => {});
    }
  });

  /** Open the landing page and show the overlay. */
  async function openOverlay(): Promise<void> {
    page = await ctx.newPage();
    await page.goto(PAGE_URL);
    await expect(page.locator('#pinpoint-shadow-host')).toHaveCount(1, { timeout: 10_000 });
    await toggleOverlay(sw, PAGE_URL);
    await expect(page.locator('fl-overlay-host fl-floating-toolbar .fl-toolbar')).toBeVisible();
    // Wait for the project to bind (members + annotations seeded).
    await page.waitForTimeout(800);
  }

  /** Click a page element in overlay mode and fill the create popover. */
  async function annotate(
    selector: string,
    opts: { tab: 'note' | 'suggestion' | 'guideline'; severity: string; body: string; screenshot?: boolean },
  ): Promise<void> {
    await page.locator(selector).click();
    const disclosure = page.locator('fl-popover fl-disclosure-modal dialog');
    if (await disclosure.isVisible().catch(() => false)) {
      await page.locator('fl-disclosure-modal button', { hasText: 'Acknowledge' }).click();
    }
    const dialog = page.locator('fl-popover dialog.fl-popover');
    await expect(dialog).toBeVisible();
    await page.locator(`fl-popover [role=tab][data-tab=${opts.tab}]`).click();
    await expect(page.locator(`fl-popover [role=tab][data-tab=${opts.tab}]`)).toHaveAttribute('aria-selected', 'true');
    await page.locator(`fl-popover .fl-severity-btn[data-severity=${opts.severity}]`).click();
    await expect(page.locator(`fl-popover .fl-severity-btn[data-severity=${opts.severity}]`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.locator('fl-popover textarea[part=textarea]').fill(opts.body);
    const capture = page.locator('fl-popover input.fl-popover-capture-checkbox');
    if (opts.screenshot === false) await capture.uncheck();
    else await capture.check();
    await page.locator('fl-popover button[data-action=submit]').click();
    await expect(dialog).toBeHidden();
  }

  async function waitForAnnotation(body: string): Promise<ApiAnnotation> {
    let found: ApiAnnotation | undefined;
    await expect
      .poll(async () => (found = (await listAnnotations()).find((a) => a.body === body)), {
        timeout: 15_000,
        intervals: [1_000],
      })
      .toBeTruthy();
    return found!;
  }

  test('popup: signed-out form, sign in, then the signed-in panel', async () => {
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 312, height: 300 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await expect(popup.getByRole('heading', { name: 'Sign in to Pinpoint' })).toBeVisible();
    await expect(popup.locator('#popup-signed-in')).toBeHidden();

    // Validation message on empty submit (never reaches the API).
    await popup.locator('#popup-submit').click();
    await expect(popup.locator('#popup-error')).toHaveText('Please enter your email and password.');
    await popup.screenshot({ path: `${SHOTS}/extension-popup-logged-out.png` });

    await popup.locator('#popup-email').fill(seed!.email || process.env.FL_E2E_EMAIL || 'e2e-seed@example.test');
    await popup.locator('#popup-password').fill(process.env.FL_E2E_PASSWORD ?? 'P@ssw0rd-E2E-1!');
    await popup.locator('#popup-submit').click();
    await expect
      .poll(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('pinpoint_auth_token')).pinpoint_auth_token)) ?? '', {
        timeout: 10_000,
      })
      .not.toBe('');
    await popup.close().catch(() => {});

    const again = await ctx.newPage();
    await again.setViewportSize({ width: 312, height: 300 });
    await again.goto(`chrome-extension://${extId}/popup/popup.html`);
    await expect(again.locator('#popup-signed-in')).toBeVisible();
    await expect(again.locator('#popup-login-form')).toBeHidden();
    await expect(again.locator('#popup-user-name')).toHaveText(seed!.body.user.name);
    await expect(again.locator('#popup-user-email')).toHaveText(seed!.body.user.email);
    await expect(again.getByRole('button', { name: 'Annotate this page' })).toBeVisible();
    await again.screenshot({ path: `${SHOTS}/extension-popup-logged-in.png` });
    await again.close();
  });

  test('options: Server URL validation and allow/block lists gate injection', async () => {
    const opts = await ctx.newPage();
    await opts.setViewportSize({ width: 900, height: 1100 });
    await opts.goto(`chrome-extension://${extId}/options/options.html`);
    const server = opts.locator('#server-url');
    await expect(server).not.toHaveValue('');
    const original = await server.inputValue();

    await server.fill('http://evil.example');
    await server.blur();
    await expect(opts.locator('#server-url-status')).toHaveText('Enter an https:// URL or http://localhost.');
    expect(
      await sw.evaluate(async () => (await chrome.storage.local.get('pinpoint_api_origin')).pinpoint_api_origin ?? null),
    ).not.toBe('http://evil.example');

    await server.fill('https://pinpoint.example.com/some/path');
    await server.blur();
    await expect(opts.locator('#server-url-status')).toHaveText('Server URL saved.');
    await expect(server).toHaveValue('https://pinpoint.example.com');
    await opts.screenshot({ path: `${SHOTS}/extension-options.png`, fullPage: true });

    // Restore the stack's API origin.
    await server.fill(original);
    await server.blur();
    await expect(opts.locator('#server-url-status')).toHaveText('Server URL saved.');
    await expect(opts.locator('#auth-state')).toHaveText('You are signed in to Pinpoint.');

    const injected = async (): Promise<boolean> => {
      const p = await ctx.newPage();
      await p.goto(PAGE_URL);
      await p.waitForTimeout(1500);
      const present = (await p.locator('#pinpoint-shadow-host').count()) > 0;
      await p.close();
      return present;
    };

    // Block-list: never inject on 127.0.0.1.
    await opts.locator('#block-list').fill('127.0.0.1');
    await opts.locator('#block-list').blur();
    await expect(opts.locator('#status')).toHaveText('Block-list saved.');
    expect(await injected(), 'block-listed host must not be injected').toBe(false);
    await opts.locator('#block-list').fill('');
    await opts.locator('#block-list').blur();

    // Non-matching allow-list: no injection; matching: injection.
    await opts.locator('#allow-list').fill('*.example.com');
    await opts.locator('#allow-list').blur();
    await expect(opts.locator('#status')).toHaveText('Allow-list saved.');
    expect(await injected(), 'host outside a non-empty allow-list must not be injected').toBe(false);
    await opts.locator('#allow-list').fill('127.0.0.1');
    await opts.locator('#allow-list').blur();
    expect(await injected(), 'allow-listed host is injected').toBe(true);
    await opts.locator('#allow-list').fill('');
    await opts.locator('#allow-list').blur();
    await opts.close();
  });

  test('click-to-annotate: popover anchored to the element, pin + API row with diagnostics', async () => {
    await openOverlay();
    // Host-page diagnostics the annotation should carry (MAIN world).
    await page.evaluate(() => (window as unknown as { triggerHostError: () => void }).triggerHostError());
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('Checkout widget crashed');
      }, 0);
    });
    await page.waitForTimeout(300);

    // The click is captured by the overlay — the host button must NOT fire.
    await page.locator('#cta').click();
    const disclosure = page.locator('fl-popover fl-disclosure-modal dialog');
    await expect(disclosure).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/extension-disclosure.png` });
    await page.locator('fl-disclosure-modal button', { hasText: 'Acknowledge' }).click();
    expect(await page.evaluate(() => (window as unknown as { __ctaClicks?: number }).__ctaClicks ?? 0)).toBe(0);

    const dialog = page.locator('fl-popover dialog.fl-popover');
    await expect(dialog).toBeVisible();
    // Anchored to the clicked element: horizontally aligned, not covering it.
    const el = (await page.locator('#cta').boundingBox())!;
    const box = (await dialog.boundingBox())!;
    expect(Math.abs(box.x - el.x)).toBeLessThan(40);
    const overlapsVertically = box.y < el.y + el.height && box.y + box.height > el.y;
    expect(overlapsVertically, 'popover must not cover the annotated element').toBe(false);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    // No stray @mention dropdown before typing "@".
    await expect(page.locator('fl-popover .fl-popover-textarea-wrap fl-mention-autocomplete')).toBeHidden();

    // Tabs + severity + body.
    await page.locator('fl-popover [role=tab][data-tab=suggestion]').click();
    await expect(page.locator('fl-popover [role=tab][data-tab=suggestion]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('fl-popover [role=tab][data-tab=note]')).toHaveAttribute('aria-selected', 'false');
    await page.locator('fl-popover .fl-severity-btn[data-severity=critical]').click();
    await expect(page.locator('fl-popover .fl-severity-btn[data-severity=critical]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('fl-popover button[data-action=submit]')).toBeDisabled();
    await page.locator('fl-popover textarea[part=textarea]').fill('Hero CTA contrast fails WCAG AA on the gradient');
    await expect(page.locator('fl-popover .fl-environment-summary-text')).toContainText('Chrome');
    // S3 may be unconfigured on the stack: take the doc screenshot with the
    // checkbox off, then switch it on for the real submit (screenshot pipeline).
    await page.locator('fl-popover input.fl-popover-capture-checkbox').uncheck();
    await page.screenshot({ path: `${SHOTS}/extension-popover-create.png` });
    await page.locator('fl-popover input.fl-popover-capture-checkbox').check();
    await page.locator('fl-popover button[data-action=submit]').click();
    await expect(dialog).toBeHidden();

    // Numbered pin at the element's corner.
    await expect.poll(() => readPins(page)).toEqual(['1']);
    const pinEl = page.locator('fl-overlay-host fl-annotation-pin').first();
    await expect(pinEl).toBeVisible();
    await expect(pinEl).toHaveAttribute('aria-label', 'Annotation pin 1', { timeout: 10_000 });
    // PinPositioner places the pin on its next tick — poll the geometry.
    // The pin sits OUTSIDE the element's top-left corner (so it never covers
    // the button label): its box overlaps the element by at most a few px.
    await expect
      .poll(async () => {
        const b = await pinEl.boundingBox();
        return b ? Math.max(Math.abs(b.x - (el.x - 22)), Math.abs(b.y - (el.y - 22))) : Infinity;
      })
      .toBeLessThan(3);
    const pinBox = (await pinEl.boundingBox())!;
    expect(pinBox.x + pinBox.width).toBeLessThanOrEqual(el.x + 8);
    expect(pinBox.y + pinBox.height).toBeLessThanOrEqual(el.y + 8);

    const row = await waitForAnnotation('Hero CTA contrast fails WCAG AA on the gradient');
    expect(row.type).toBe('suggestion');
    expect(row.severity).toBe('critical');
    expect(row.pinNumber).toBe(1);
    expect(row.target.cssSelector).toBe('#cta');
    expect(row.target.tagName).toBe('BUTTON');
    expect(row.target.textSnippet).toBe('Start free trial');
    expect(row.environment?.browserFamily).toBe('Chrome');
    expect(row.environment?.userAgentRaw).toContain('Chrome');
    expect(row.consoleLogs?.map((l) => l.message)).toContain('Pricing API failed: GET /api/prices 500');
    expect(row.jsErrors?.some((e) => e.kind === 'error' && e.message.includes('Checkout widget crashed'))).toBe(true);

    // Screenshot pipeline: uploaded against the CANONICAL id. On a stack
    // without object storage the server rejects the upload with 5xx and
    // the toolbar says so; with storage the object key is persisted.
    // FL_S3_ENABLED=1 (set when MinIO/S3 is provisioned) makes storage mandatory.
    const toast = page.locator('fl-floating-toolbar .fl-toolbar-toast');
    await expect
      .poll(
        async () => {
          const text = (await toast.textContent()) ?? '';
          if (text.startsWith('Could not upload screenshot: ')) return text;
          // Only hit the API occasionally (tenant rate limit is shared).
          const fresh = (await listAnnotations()).find((a) => a.id === row.id);
          return fresh?.screenshotObjectKey ? 'stored' : '';
        },
        { timeout: 20_000, intervals: [2_000] },
      )
      .toMatch(/^stored$|^Could not upload screenshot: /);
    const toastText = (await toast.textContent()) ?? '';
    if (process.env.FL_S3_ENABLED === '1') {
      // Object storage is provisioned (MinIO locally / in CI): the lenient
      // "server failure" branch is NOT acceptable — the key must be stored
      // and the URL the clients put in <img src> must actually serve the PNG.
      expect(toastText, 'screenshot upload must not fail when S3 is enabled').toBe('');
      const stored = (await listAnnotations()).find((a) => a.id === row.id);
      expect(stored?.screenshotObjectKey, 'screenshotObjectKey must be persisted').toBeTruthy();
      const { screenshotUrl } = await api<{ screenshotUrl: string }>(`/annotations/${row.id}/screenshot`);
      const img = await fetch(screenshotUrl); // no credentials, like a browser <img>
      expect(img.status, 'screenshotUrl must be loadable without credentials').toBe(200);
      const bytes = Buffer.from(await img.arrayBuffer());
      expect(bytes.subarray(0, 8).toString('hex'), 'PNG signature').toBe('89504e470d0a1a0a');
      return;
    }
    if (toastText) {
      // Rejected by the SERVER (no object storage on this stack), never a
      // client-side 404 against the optimistic id or a sync timeout.
      expect(toastText).not.toMatch(/not found|404|not synced/i);
      test.info().annotations.push({ type: 'screenshot', description: `server rejected upload: ${toastText}` });
    }
  });

  test('more annotations: Note + Guideline → three numbered pins, then the comment thread with @mention', async () => {
    await annotate('#buy-pro', { tab: 'note', severity: 'major', body: 'Pro CTA label should say "Start Pro trial"', screenshot: false });
    await annotate('#nav-pricing', { tab: 'guideline', severity: 'minor', body: 'Nav link lacks a visible focus ring', screenshot: false });
    await expect.poll(() => readPins(page), { timeout: 10_000 }).toEqual(['1', '2', '3']);
    await waitForAnnotation('Nav link lacks a visible focus ring');
    await expect
      .poll(async () => page.locator('fl-overlay-host fl-annotation-pin[data-pending]').count(), { timeout: 10_000 })
      .toBe(0);
    // Let any screenshot-upload toast from pin #1 expire before documenting.
    await expect(page.locator('fl-floating-toolbar .fl-toolbar-toast')).toBeHidden({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/extension-overlay-3-pins.png` });

    // A teammate already commented on pin #2 from the dashboard.
    const second = (await listAnnotations()).find((a) => a.pinNumber === 2)!;
    await api(`/annotations/${second.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Copy team owns this label.' }),
    });

    // Open pin #2 → view mode with its comment thread (existing comment loaded).
    await page.locator('fl-overlay-host fl-annotation-pin', { hasText: '2' }).click();
    const dialog = page.locator('fl-popover dialog.fl-popover');
    await expect(dialog).toBeVisible();
    await expect(page.locator('fl-popover .fl-popover-view')).toBeVisible();
    await expect(page.locator('fl-popover .fl-annotation-body')).toHaveText('Pro CTA label should say "Start Pro trial"');

    const composer = page.locator('fl-popover fl-comment-thread textarea');
    await composer.click();
    await composer.pressSequentially('Agreed — @E2', { delay: 20 });
    const options = page.locator('fl-comment-thread fl-mention-autocomplete li.fl-mention-item');
    await expect(options.first()).toBeVisible();
    await expect(options.first()).toContainText(seed!.body.user.name);
    await page.keyboard.press('Enter'); // picks the highlighted member
    await expect(composer).toHaveValue(`Agreed — @${seed!.body.user.name} `);
    await composer.pressSequentially('can you take this one?');
    await page.locator('fl-popover fl-comment-thread button.fl-btn-primary').click();
    const rendered = page.locator('fl-popover fl-comment-thread .fl-comment');
    await expect(rendered).toHaveCount(2);
    await expect(rendered.first().locator('.fl-comment-body')).toHaveText('Copy team owns this label.');
    // Authors are shown by name, never as a raw user id.
    await expect(page.locator('fl-popover fl-comment-thread .fl-comment-author').first()).toHaveText(seed!.body.user.name);

    const target = second;
    type C = { body: string; mentions: string[] };
    await expect
      .poll(async () => (await api<{ data?: C[] }>(`/annotations/${target.id}/comments`)).data?.length ?? 0, {
        timeout: 10_000,
        intervals: [1_000],
      })
      .toBe(2);
    const comments = (await api<{ data: C[] }>(`/annotations/${target.id}/comments`)).data;
    expect(comments[1].body).toBe(`Agreed — @${seed!.body.user.name} can you take this one?`);
    // Mentions travel as USER IDS (the server notifies by id).
    expect(comments[1].mentions).toContain(seed!.body.user.id);
    // No duplicate row once the socket echo + Syncer remap settle.
    await page.waitForTimeout(1000);
    await expect(rendered).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/extension-popover-view-comments.png` });

    // Resolve → API resolved; Reopen → active.
    await page.locator('fl-popover button[data-action=resolve]').click();
    await expect.poll(async () => (await listAnnotations()).find((a) => a.id === target.id)?.status, { timeout: 10_000, intervals: [1_000] }).toBe('resolved');
    await expect(page.locator('fl-popover button[data-action=reopen]')).toBeVisible();
    await page.locator('fl-popover button[data-action=reopen]').click();
    await expect.poll(async () => (await listAnnotations()).find((a) => a.id === target.id)?.status, { timeout: 10_000, intervals: [1_000] }).toBe('active');
    await page.locator('fl-popover button[data-action=close]').click();
    await expect(dialog).toBeHidden();
  });

  test('sidebar (Alt+Shift+S command + toolbar button) lists Active / Resolved', async () => {
    // Resolve pin #3 from the extension so both tabs have content. (Status
    // changes made by OTHER clients are covered by the realtime status test
    // below — the extension listens for `annotation.status_changed`.)
    await page.locator('fl-overlay-host fl-annotation-pin', { hasText: '3' }).click();
    await page.locator('fl-popover button[data-action=resolve]').click();
    const third = (await listAnnotations()).find((a) => a.pinNumber === 3)!;
    await expect.poll(async () => (await listAnnotations()).find((a) => a.id === third.id)?.status, { timeout: 10_000, intervals: [1_000] }).toBe('resolved');
    if (await page.locator('fl-popover dialog.fl-popover').isVisible()) {
      await page.locator('fl-popover button[data-action=close]').click();
    }

    const sidebar = page.locator('fl-overlay-host fl-sidebar-panel .fl-sidebar');
    await expect(sidebar).toBeHidden(); // closed by default — never covers the page uninvited
    await sendCommand(sw, PAGE_URL, 'toggle-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.locator('fl-sidebar-panel [role=tab][data-tab=active]')).toHaveText(/Active \(2\)/, { timeout: 10_000 });
    await expect(page.locator('fl-sidebar-panel [role=tab][data-tab=resolved]')).toHaveText(/Resolved \(1\)/);
    await expect(page.locator('fl-sidebar-panel li.fl-sidebar-item')).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/extension-sidebar.png` });
    await page.locator('fl-sidebar-panel [role=tab][data-tab=resolved]').click();
    await expect(page.locator('fl-sidebar-panel li.fl-sidebar-item')).toHaveCount(1);
    await expect(page.locator('fl-sidebar-panel li.fl-sidebar-item .fl-annotation-body')).toHaveText('Nav link lacks a visible focus ring');

    // Row click opens that annotation.
    await page.locator('fl-sidebar-panel li.fl-sidebar-item').click();
    await expect(page.locator('fl-popover .fl-annotation-body')).toHaveText('Nav link lacks a visible focus ring');
    await page.keyboard.press('Escape');
    await expect(page.locator('fl-popover dialog.fl-popover')).toBeHidden();

    // Toolbar toggle reflects + closes; sidebar × closes only the sidebar.
    const toggle = page.locator('fl-floating-toolbar button[data-action=sidebar]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(sidebar).toBeHidden();
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await page.locator('fl-sidebar-panel button.fl-close-btn').click();
    await expect(sidebar).toBeHidden();
    await expect(page.locator('fl-overlay-host fl-floating-toolbar .fl-toolbar')).toBeVisible();
  });

  test('next / prev pin commands step through annotations and move focus', async () => {
    const body = page.locator('fl-popover .fl-annotation-body');
    await sendCommand(sw, PAGE_URL, 'next-pin');
    await expect(body).toHaveText('Hero CTA contrast fails WCAG AA on the gradient');
    await sendCommand(sw, PAGE_URL, 'next-pin');
    await expect(body).toHaveText('Pro CTA label should say "Start Pro trial"');
    await sendCommand(sw, PAGE_URL, 'prev-pin');
    await expect(body).toHaveText('Hero CTA contrast fails WCAG AA on the gradient');
    await sendCommand(sw, PAGE_URL, 'prev-pin'); // wraps to the last pin
    await expect(body).toHaveText('Nav link lacks a visible focus ring');
    // Focus moved into the opened annotation's dialog (modal focus trap).
    const focusedInsidePopover = await page.evaluate(() => {
      let el: Element | null = document.activeElement;
      const path: string[] = [];
      while (el) {
        path.push(el.tagName.toLowerCase());
        el = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement ?? null;
      }
      return path;
    });
    expect(focusedInsidePopover).toContain('fl-popover');
    await page.keyboard.press('Escape');
  });

  test('floating toolbar: copy link and close', async () => {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await page.locator('fl-floating-toolbar button[data-action=link]').click();
    await expect(page.locator('fl-floating-toolbar .fl-toolbar-toast')).toHaveText('Page link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PAGE_URL);

    await page.locator('fl-floating-toolbar button[data-action=close]').click();
    await expect(page.locator('#pinpoint-shadow-host')).toBeHidden();
    // Page clicks are no longer intercepted once the overlay is closed.
    await page.locator('#cta').click();
    expect(await page.evaluate(() => (window as unknown as { __ctaClicks?: number }).__ctaClicks ?? 0)).toBe(1);
    await toggleOverlay(sw, PAGE_URL);
    await expect(page.locator('fl-overlay-host fl-floating-toolbar .fl-toolbar')).toBeVisible();
  });

  test('realtime: an annotation created by another client appears without reload', async () => {
    const before = (await readPins(page)).length;
    await api(`/projects/${projectId}/annotations`, {
      method: 'POST',
      body: JSON.stringify({
        pageUrl: PAGE_URL,
        body: 'From a teammate (dashboard)',
        type: 'note',
        severity: 'informational',
        target: { cssSelector: '#footer', xpath: '/html/body/footer', pageX: 48, pageY: 760, tagName: 'FOOTER', textSnippet: '' },
        environment: { browserFamily: 'Firefox', browserVersion: '1', osFamily: 'Linux', osVersion: '1', deviceType: 'desktop', userAgentRaw: 'ua' },
      }),
    });
    await expect.poll(async () => (await readPins(page)).length, { timeout: 15_000 }).toBe(before + 1);
    expect(await readPins(page)).toContain('4');
  });

  test('realtime: a status change by another client updates the sidebar counts (annotation.status_changed)', async () => {
    const teammate = (await listAnnotations()).find((a) => a.pinNumber === 4)!;
    const activeTab = page.locator('fl-sidebar-panel [role=tab][data-tab=active]');
    const resolvedTab = page.locator('fl-sidebar-panel [role=tab][data-tab=resolved]');
    await expect(activeTab).toHaveText(/Active \(3\)/, { timeout: 10_000 });
    await expect(resolvedTab).toHaveText(/Resolved \(1\)/);

    await api(`/annotations/${teammate.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'resolved' }) });
    await expect(resolvedTab).toHaveText(/Resolved \(2\)/, { timeout: 15_000 });
    await expect(activeTab).toHaveText(/Active \(2\)/);

    // Restore so later tests see the original data set (and prove the reverse transition).
    await api(`/annotations/${teammate.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) });
    await expect(activeTab).toHaveText(/Active \(3\)/, { timeout: 15_000 });
  });

  test('offline: annotation is queued as pending, then syncs when back online', async () => {
    await ctx.setOffline(true);
    await expect(page.locator('fl-floating-toolbar .fl-offline-banner')).toBeVisible({ timeout: 10_000 });
    await annotate('#buy-team', { tab: 'note', severity: 'minor', body: 'Queued while offline', screenshot: false });
    const pending = page.locator('fl-overlay-host fl-annotation-pin[data-pending=true]');
    await expect(pending).toHaveCount(1);
    await expect(pending).toHaveAttribute('aria-label', /not synced yet/);
    await page.waitForTimeout(1500);
    expect((await listAnnotations()).some((a) => a.body === 'Queued while offline')).toBe(false);

    // Resolve is disabled for an unsynced annotation while offline.
    await pending.click();
    await expect(page.locator('fl-popover button[data-action=resolve]')).toBeDisabled();
    await page.keyboard.press('Escape');

    await ctx.setOffline(false);
    const row = await waitForAnnotation('Queued while offline');
    expect(row.pinNumber).toBe(5);
    await expect(pending).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('fl-floating-toolbar .fl-offline-banner')).toBeHidden({ timeout: 20_000 });
    // Exactly one pin per annotation (no duplicate from the socket echo).
    await expect.poll(() => readPins(page)).toEqual(['1', '2', '3', '4', '5']);
  });

  test('pin on a full-width header (x=0,y=0) is clamped into the viewport and stays focusable', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('header').click({ position: { x: 640, y: 30 } });
    await page.locator('fl-popover textarea[part=textarea]').fill('Header spacing is inconsistent');
    await page.locator('fl-popover input.fl-popover-capture-checkbox').uncheck();
    await page.locator('fl-popover button[data-action=submit]').click();
    await expect(page.locator('fl-popover dialog.fl-popover')).toBeHidden();
    const header = (await page.locator('header').boundingBox())!;
    expect(header.x).toBe(0);
    expect(header.y).toBe(0);
    const pin = page.locator('fl-overlay-host fl-annotation-pin', { hasText: '6' });
    await expect(pin).toBeVisible();
    await expect
      .poll(async () => {
        const b = await pin.boundingBox();
        return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1280 && b.y + b.height <= 800;
      })
      .toBe(true);
    // Keyboard reachable: pins are focusable.
    await pin.focus();
    expect(await pin.getAttribute('tabindex')).toBe('0');
    // Scrolling keeps the pin glued to its (scrolled-away) element: the pin
    // is page-positioned, so it leaves the viewport together with the header.
    await page.evaluate(() => {
      document.querySelector('footer')!.style.marginTop = '2000px';
      window.scrollTo(0, 400);
    });
    await expect.poll(async () => (await pin.boundingBox())?.y ?? 0).toBeLessThan(0);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('footer')!.style.marginTop = '';
    });
    await expect.poll(async () => (await pin.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  });

  test('sidebar collapses to a rail, remembers it per tab, and becomes a bottom sheet on narrow viewports', async () => {
    const sidebar = page.locator('fl-overlay-host fl-sidebar-panel .fl-sidebar');
    await sendCommand(sw, PAGE_URL, 'toggle-sidebar');
    await expect(sidebar).toBeVisible();
    expect((await sidebar.boundingBox())!.width).toBeGreaterThan(300);

    await page.locator('fl-sidebar-panel button.fl-collapse-btn').click();
    await expect(sidebar).toHaveAttribute('data-collapsed', '');
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(60);
    const expand = page.locator('fl-sidebar-panel button.fl-rail-btn');
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('fl-sidebar-panel .fl-rail-badge')).toHaveText(/^\d+$/);

    // Remembered per tab: reload the same tab, reopen the overlay + sidebar.
    await page.reload();
    await expect(page.locator('#pinpoint-shadow-host')).toHaveCount(1, { timeout: 10_000 });
    await toggleOverlay(sw, PAGE_URL);
    await sendCommand(sw, PAGE_URL, 'toggle-sidebar');
    await expect(sidebar).toHaveAttribute('data-collapsed', '');

    // Another tab starts expanded (state is per tab, not global).
    const other = await ctx.newPage();
    await other.goto(PAGE_URL);
    await expect(other.locator('#pinpoint-shadow-host')).toHaveCount(1, { timeout: 10_000 });
    expect(await other.evaluate(() => sessionStorage.getItem('pinpoint:sidebar-collapsed'))).toBeNull();
    await other.close();
    await page.bringToFront();

    await page.locator('fl-sidebar-panel button.fl-rail-btn').click();
    await expect(sidebar).not.toHaveAttribute('data-collapsed', '');
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(300);

    // Narrow viewport: bottom sheet spanning the width.
    await page.setViewportSize({ width: 480, height: 800 });
    await expect
      .poll(async () => {
        const b = (await sidebar.boundingBox())!;
        return b.width >= 478 && b.y > 200 && Math.round(b.y + b.height) === 800;
      })
      .toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('fl-sidebar-panel button.fl-close-btn').click();
    await expect(sidebar).toBeHidden();
  });

  test('popover clamps clear of the floating toolbar (and its toast strip) and the sidebar', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The footer sits directly under the toolbar: the worst case.
    await page.locator('#footer span').first().click();
    const dialog = page.locator('fl-popover dialog.fl-popover');
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const bar = (await page.locator('fl-floating-toolbar .fl-toolbar').boundingBox())!;
    const strip = 44;
    const overlapsToolbar =
      box.x < bar.x + bar.width && box.x + box.width > bar.x && box.y < bar.y + bar.height && box.y + box.height > bar.y - strip;
    expect(overlapsToolbar, `popover ${JSON.stringify(box)} vs toolbar ${JSON.stringify(bar)}`).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // With the sidebar open the popover never opens underneath it.
    await sendCommand(sw, PAGE_URL, 'toggle-sidebar');
    const sidebar = page.locator('fl-overlay-host fl-sidebar-panel .fl-sidebar');
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.locator('#cta').click({ position: { x: 20, y: 10 } });
    await expect(dialog).toBeVisible();
    const sb = (await sidebar.boundingBox())!;
    const box2 = (await dialog.boundingBox())!;
    expect(box2.x + box2.width).toBeLessThanOrEqual(sb.x + 1);
    await page.keyboard.press('Escape');
    await page.locator('fl-sidebar-panel button.fl-close-btn').click();
    await page.setViewportSize({ width: 1280, height: 800 });

    // A toast shown with the popover closed stacks directly above the toolbar.
    await page.locator('fl-floating-toolbar button[data-action=link]').click();
    const toast = page.locator('fl-floating-toolbar .fl-toolbar-toast');
    await expect(toast).toBeVisible();
    const t = (await toast.boundingBox())!;
    const bar2 = (await page.locator('fl-floating-toolbar .fl-toolbar').boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual(bar2.y);
  });

  test('disclosure backdrop fully covers the floating toolbar', async () => {
    // `sendToTab` targets the FIRST tab on PAGE_URL: retire the old one.
    await page.close();
    const fresh = await ctx.newPage();
    // New origin path → a different host key is NOT used; disclosure-seen is
    // per host, so reset it to make the modal appear again.
    await sw.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const sync = await chrome.storage.sync.get(null);
      for (const k of Object.keys({ ...all, ...sync })) {
        if (k.includes('disclosure')) {
          await chrome.storage.local.remove(k);
          await chrome.storage.sync.remove([k]);
        }
      }
    });
    await fresh.goto(PAGE_URL);
    await expect(fresh.locator('#pinpoint-shadow-host')).toHaveCount(1, { timeout: 10_000 });
    await toggleOverlay(sw, PAGE_URL);
    await fresh.waitForTimeout(500);
    await fresh.locator('#cta').click();
    await expect(fresh.locator('fl-popover fl-disclosure-modal dialog')).toBeVisible();
    // Playwright's actionability hit-test: every toolbar button must be
    // OBSCURED by the modal's backdrop (a trial click would otherwise pass).
    for (const action of ['close', 'avatar', 'sidebar', 'share', 'link']) {
      const btn = fresh.locator(`fl-floating-toolbar button[data-action=${action}]`);
      const err = await btn.click({ trial: true, timeout: 1500 }).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(err, `toolbar "${action}" must sit under the backdrop`).toMatch(/intercepts pointer events/);
    }
    await fresh.locator('fl-disclosure-modal button', { hasText: 'Acknowledge' }).click();
    await fresh.keyboard.press('Escape');
    await fresh.close();
  });

  test('axe: options page and popup have no critical/serious violations', async () => {
    for (const path of ['options/options.html', 'popup/popup.html']) {
      const p = await ctx.newPage();
      await p.setViewportSize(path.startsWith('popup') ? { width: 312, height: 400 } : { width: 900, height: 1100 });
      await p.goto(`chrome-extension://${extId}/${path}`);
      await p.waitForTimeout(500);
      const results = await new AxeBuilder({ page: p }).analyze();
      const bad = results.violations
        .filter((v) => v.impact === 'critical' || v.impact === 'serious')
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ t: n.target, s: n.failureSummary })) }));
      expect(bad, `${path}: ${JSON.stringify(bad, null, 2)}`).toEqual([]);
      await p.close();
    }
  });
});
