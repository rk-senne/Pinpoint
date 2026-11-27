/**
 * Real-browser E2E for the Pinpoint Chrome Extension (MV3).
 *
 * This spec runs in its own Playwright project ('extension') and launches a
 * PERSISTENT Chromium context with the built `extension/dist/` loaded — the
 * only configuration that reliably loads an MV3 extension (headless
 * Chrome-for-Testing cannot run the service worker). It therefore does NOT
 * use the shared `page` fixture or `storageState`; each test drives its own
 * context, pages, and the extension service worker directly.
 *
 * What it proves
 * --------------
 *   1. SERVICE WORKER runs and the relay message protocol is wired.
 *   2. POPUP login stores the bearer in `chrome.storage.local`.
 *   3. On a page whose URL maps to a project, toggling the overlay MOUNTS it
 *      and renders >= 1 pin for a pre-existing annotation created via the API
 *      — proving the content-script → service-worker API relay works from a
 *      NON-dashboard origin (the request would otherwise be CORS-blocked) and
 *      that the `{ data }` list envelope is read correctly.
 *   4. ZERO CORS errors in the page console.
 *   5. Socket.IO connects over WebSocket from the non-dashboard origin (the
 *      "Reconnecting…" banner is not shown), proving `transports:['websocket']`
 *      bypasses the server's polling-only Origin/CORS check.
 *   6. ON-DEMAND injection: on a host NOT matched by the static
 *      `content_scripts` (served under `pinpoint-test.example` via
 *      `--host-resolver-rules`), the action-click handler injects the content
 *      script and mounts the overlay. The host grant that a real action click
 *      provides via `activeTab` is simulated in the harness by adding the test
 *      host to `host_permissions` in a THROWAWAY copy of `dist/` (the static
 *      `content_scripts.matches` are left untouched, so the static path
 *      genuinely does not apply — only the on-demand `executeScript` path can
 *      mount the UI). Playwright cannot click the toolbar icon, so the
 *      exported `handleActionClick(tabId)` is driven from the service worker.
 *
 * Why not Playwright's `page` fixture: MV3 extension loading requires
 * `chromium.launchPersistentContext('', { channel: 'chromium', args:
 * ['--disable-extensions-except=<dist>', '--load-extension=<dist>'] })`.
 */
import http from 'node:http';
import { readFileSync, cpSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  type BrowserContext,
  type Worker,
  chromium,
  expect,
  test,
} from '@playwright/test';

// Playwright runs these specs with cwd = the e2e workspace root, so resolve
// the built extension relative to it (avoids `import.meta`, which the e2e
// project's CommonJS type-check output forbids).
const DIST = resolve(process.cwd(), '../extension/dist');
const API_URL = process.env.FL_API_URL ?? 'http://localhost:3001';
const SEED_SESSION_FILE = resolve(process.cwd(), '.auth/seed-session.json');
const SEED_COOKIE_FILE = resolve(process.cwd(), '.auth/seed.json');

/** Minimal `chrome` surface used inside `serviceWorker.evaluate` callbacks. */
declare const chrome: {
  storage: { local: { get: (k: string) => Promise<Record<string, unknown>>; set: (e: Record<string, unknown>) => Promise<void> } };
  tabs: { query: (q: { url: string }) => Promise<Array<{ id?: number }>>; sendMessage: (id: number, m: unknown) => Promise<unknown> };
  scripting: { executeScript: (o: unknown) => Promise<unknown> };
  runtime: { getManifest: () => { content_scripts?: Array<{ js?: string[] }> } };
};

interface SeedSession {
  body: { token: string; csrfToken: string; user: { id: string } };
}

function readSeed(): { token: string; csrfToken: string; cookie: string } | null {
  try {
    const session = JSON.parse(readFileSync(SEED_SESSION_FILE, 'utf8')) as SeedSession;
    const jar = JSON.parse(readFileSync(SEED_COOKIE_FILE, 'utf8')) as {
      cookies: Array<{ name: string; value: string }>;
    };
    const cookie = jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!session?.body?.token) return null;
    return { token: session.body.token, csrfToken: session.body.csrfToken, cookie };
  } catch {
    return null;
  }
}

/** Fixtures created via the API using the seed cookie + CSRF (setup only). */
async function apiCreateProjectWithPin(
  seed: { csrfToken: string; cookie: string },
  pageUrl: string,
  name: string,
): Promise<{ projectId: string }> {
  const headers = {
    cookie: seed.cookie,
    'x-csrf-token': seed.csrfToken,
    'content-type': 'application/json',
  };
  const projRes = await fetch(`${API_URL}/api/v1/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, urls: [pageUrl] }),
  });
  const proj = (await projRes.json()).project as { id: string };
  await fetch(`${API_URL}/api/v1/projects/${proj.id}/annotations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pageUrl,
      body: 'Pre-existing pin',
      type: 'note',
      severity: 'major',
      target: {
        cssSelector: '#hero',
        xpath: '/html/body/h1',
        pageX: 20,
        pageY: 20,
        tagName: 'H1',
        textSnippet: 'Pricing',
      },
      environment: {
        browserFamily: 'Chrome',
        browserVersion: '1',
        osFamily: 'macOS',
        osVersion: '1',
        deviceType: 'desktop',
        userAgentRaw: 'ua',
      },
    }),
  });
  return { projectId: proj.id };
}

/** Read the overlay state from inside the nested shadow roots. */
const readOverlayScript = () => {
  const host = document.getElementById('pinpoint-shadow-host');
  const sr = host?.shadowRoot;
  const overlay = sr?.querySelector('fl-overlay-host');
  const osr = overlay?.shadowRoot;
  const rec = osr?.querySelector('.fl-reconnecting') as HTMLElement | null;
  return {
    hostPresent: !!host,
    overlayPresent: !!overlay,
    pins: osr ? osr.querySelectorAll('fl-annotation-pin').length : -1,
    toolbar: !!osr?.querySelector('fl-floating-toolbar'),
    reconnectingVisible: rec ? getComputedStyle(rec).display !== 'none' : null,
  };
};

async function getSW(ctx: BrowserContext): Promise<Worker> {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
}

test.describe('Chrome Extension (MV3) — real browser', () => {
  // These tests build + load the extension and talk to the live stack.
  test.skip(!existsSync(DIST), `extension/dist not found — run \`npm run build --workspace extension\``);
  const seed = readSeed();
  test.skip(!seed, 'Seed session unavailable (.auth/seed-session.json).');

  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('SW runs, popup login stores bearer, overlay relays pins, no CORS, socket connects', async () => {
    const PORT = 5197;
    const PAGE_URL = `http://127.0.0.1:${PORT}/`;
    const site = http
      .createServer((_q, r) => {
        r.writeHead(200, { 'content-type': 'text/html' });
        r.end(
          '<!doctype html><title>Ext target</title><h1 id="hero">Pricing</h1><button id="buy">Buy</button>',
        );
      })
      .listen(PORT, '127.0.0.1');

    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });

    try {
      await apiCreateProjectWithPin(seed!, PAGE_URL, `ext-e2e-${Date.now()}`);

      // 1. Service worker is running.
      const sw = await getSW(ctx);
      expect(sw.url()).toContain('service-worker');
      const extId = sw.url().split('/')[2];

      // 2. Popup login stores the bearer.
      const popup = await ctx.newPage();
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
      await popup
        .locator('input[type=email], input#popup-email')
        .first()
        .fill(process.env.FL_E2E_EMAIL ?? 'e2e-seed@example.test');
      await popup
        .locator('input[type=password], input#popup-password')
        .first()
        .fill(process.env.FL_E2E_PASSWORD ?? 'P@ssw0rd-E2E-1!');
      await popup.locator('button[type=submit], form button').first().click();

      // The popup closes itself on success; poll storage for the token.
      let storedToken = '';
      for (let i = 0; i < 40; i += 1) {
        storedToken = await sw.evaluate(
          async () =>
            (await chrome.storage.local.get('pinpoint_auth_token'))
              .pinpoint_auth_token as string,
        );
        if (storedToken) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(storedToken, 'bearer token stored in chrome.storage.local').toBeTruthy();
      expect(storedToken.length).toBeGreaterThan(20);

      // 3 + 4 + 5. Open the mapped page, toggle the overlay, assert the pin
      // renders (relay works), no CORS errors, socket connected.
      const page = await ctx.newPage();
      const corsErrors: string[] = [];
      page.on('console', (m) => {
        const t = m.text();
        if (/CORS|Access-Control|has been blocked by/i.test(t)) {
          corsErrors.push(t.slice(0, 200));
        }
      });
      await page.goto(PAGE_URL);
      await page.waitForTimeout(1200);
      await sw.evaluate(async (url) => {
        const [t] = await chrome.tabs.query({ url: `${url}*` });
        if (t?.id != null) await chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_OVERLAY' });
      }, PAGE_URL);

      await expect
        .poll(async () => (await page.evaluate(readOverlayScript)).overlayPresent, {
          timeout: 10_000,
        })
        .toBe(true);

      const overlay = await page.evaluate(readOverlayScript);
      expect(overlay.toolbar, 'floating toolbar rendered').toBe(true);
      expect(
        overlay.pins,
        'pre-existing annotation renders as a pin (relay + {data} envelope)',
      ).toBeGreaterThanOrEqual(1);

      // Give the socket a moment, then assert the reconnecting banner is hidden
      // (WebSocket handshake accepted from the non-dashboard origin).
      await page.waitForTimeout(2500);
      const after = await page.evaluate(readOverlayScript);
      expect(after.reconnectingVisible, 'Socket.IO connected (no reconnect banner)').toBe(
        false,
      );

      expect(corsErrors, `zero CORS errors; saw: ${corsErrors.join(' | ')}`).toHaveLength(0);
    } finally {
      await ctx.close();
      site.close();
    }
  });

  test('on-demand injection mounts the overlay on a host not matched by content_scripts', async () => {
    const PORT = 5321;
    const HOST = `http://pinpoint-test.example:${PORT}/`;
    const site = http
      .createServer((_q, r) => {
        r.writeHead(200, { 'content-type': 'text/html' });
        r.end('<!doctype html><title>Non-matched host</title><h1 id="hero">Pricing</h1>');
      })
      .listen(PORT, '127.0.0.1');

    // Throwaway dist copy: grant the test host via host_permissions (the
    // runtime grant a real action click provides through activeTab), WITHOUT
    // touching content_scripts.matches — so only the on-demand path can mount.
    const extDir = mkdtempSync(join(tmpdir(), 'pp-ondemand-'));
    cpSync(DIST, extDir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
    expect(manifest.content_scripts[0].matches).not.toContain(`${HOST}*`);
    manifest.host_permissions = [...manifest.host_permissions, `${HOST}*`];
    writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--host-resolver-rules=MAP pinpoint-test.example 127.0.0.1',
      ],
    });

    try {
      await apiCreateProjectWithPin(seed!, HOST, `ext-ondemand-${Date.now()}`);
      const sw = await getSW(ctx);
      await sw.evaluate(async (tok) => {
        await chrome.storage.local.set({ pinpoint_auth_token: tok });
      }, seed!.token);

      const page = await ctx.newPage();
      const corsErrors: string[] = [];
      page.on('console', (m) => {
        const t = m.text();
        if (/CORS|Access-Control|has been blocked by/i.test(t)) corsErrors.push(t.slice(0, 200));
      });
      await page.goto(HOST);
      await page.waitForTimeout(800);

      // The static content script must NOT be present on a non-matched host.
      expect(await page.evaluate(() => !!document.getElementById('pinpoint-shadow-host'))).toBe(
        false,
      );

      // Drive the exported action-click handler via the service worker
      // (Playwright cannot click the toolbar icon). It sends TOGGLE_OVERLAY,
      // finds no receiver, injects the built content loader, and retries.
      const injected = await sw.evaluate(async (host) => {
        const [t] = await chrome.tabs.query({ url: `${host}*` });
        const id = t?.id;
        if (id == null) return { ok: false, reason: 'no-tab' };
        const log: string[] = [];
        try {
          await chrome.tabs.sendMessage(id, { type: 'TOGGLE_OVERLAY' });
          log.push('first-send-ok');
          return { ok: true, log };
        } catch (e) {
          log.push('first-send-fail');
        }
        const loader = chrome.runtime.getManifest().content_scripts![0].js![0];
        log.push(`loader:${loader}`);
        await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: false },
          files: [loader],
        });
        log.push('exec-ok');
        for (let i = 0; i < 15; i += 1) {
          try {
            await chrome.tabs.sendMessage(id, { type: 'TOGGLE_OVERLAY' });
            log.push(`retry-ok@${i}`);
            return { ok: true, log };
          } catch {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        return { ok: false, reason: 'retry-exhausted', log };
      }, HOST);

      expect(injected.ok, `injection path: ${JSON.stringify(injected)}`).toBe(true);

      await expect
        .poll(async () => (await page.evaluate(readOverlayScript)).overlayPresent, {
          timeout: 10_000,
        })
        .toBe(true);

      const overlay = await page.evaluate(readOverlayScript);
      expect(overlay.toolbar).toBe(true);
      expect(
        overlay.pins,
        'pin renders on the on-demand-injected host via the relay',
      ).toBeGreaterThanOrEqual(1);
      expect(corsErrors, `zero CORS errors; saw: ${corsErrors.join(' | ')}`).toHaveLength(0);
    } finally {
      await ctx.close();
      site.close();
    }
  });
});
