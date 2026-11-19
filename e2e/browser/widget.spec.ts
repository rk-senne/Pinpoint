/**
 * Real-UI: widget embed cross-origin (e).
 *
 * Serves a static HTML page from a tiny Node http server on two origins:
 *   - ALLOWED     : http://127.0.0.1:5199  (in the widget key's allowedOrigins)
 *   - NOT ALLOWED : http://127.0.0.1:5198  (absent from allowedOrigins)
 *
 * The CORE proof is that a REAL browser can POST feedback cross-origin to
 * `/api/v1/widget/feedback`: the allowed origin succeeds (201 + the browser
 * receives the reflected ACAO), and the non-allowed origin is blocked (ACAO
 * withheld + server 403). The widget's own trigger lives in a CLOSED shadow
 * root (opaque to Playwright), so the submission is issued via `page.evaluate`
 * performing the exact request the widget makes — the Origin header is set by
 * the browser, so this still exercises the genuine CORS machinery.
 *
 * A secondary check loads the embed SDK `<script>` itself and asserts
 * `window.Pinpoint.init` ran. See the summary for a REAL APP BUG this uncovers
 * (the widget asset is served with `Cross-Origin-Resource-Policy: same-origin`,
 * which blocks cross-origin `<script>` loads).
 */
import { createServer, type Server } from 'node:http';

import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  API_URL,
  createProject,
  createWidgetKey,
  deleteProject,
  listAnnotations,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

const ALLOWED_PORT = 5199;
const BLOCKED_PORT = 5198;
const ALLOWED_ORIGIN = `http://127.0.0.1:${ALLOWED_PORT}`;
const BLOCKED_ORIGIN = `http://127.0.0.1:${BLOCKED_PORT}`;

function widgetPage(apiUrl: string, projectKey: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Widget host</title></head>
  <body>
    <h1>Widget host page</h1>
    <script src="${apiUrl}/widget/pinpoint-widget.js"></script>
    <script>
      window.__pinpointReady = false;
      try {
        window.Pinpoint.init({ projectKey: ${JSON.stringify(projectKey)}, apiUrl: ${JSON.stringify(apiUrl)} });
        window.__pinpointReady = true;
      } catch (e) { window.__pinpointInitError = String(e); }
    </script>
  </body>
</html>`;
}

function startServer(html: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

test.describe('widget embed cross-origin', () => {
  let api: ApiClient | null;
  const toCleanup: CreatedProject[] = [];
  let allowedServer: Server | null = null;
  let blockedServer: Server | null = null;

  test.beforeAll(async () => {
    api = await makeApiClient();
  });

  test.afterAll(async () => {
    if (api) {
      while (toCleanup.length) {
        const p = toCleanup.pop()!;
        await deleteProject(api, p).catch(() => {});
      }
    }
    await closeServer(allowedServer);
    await closeServer(blockedServer);
    await api?.dispose();
  });

  test('(e) cross-origin feedback: allowed origin 201, non-allowed origin blocked', async ({
    browser,
  }) => {
    test.skip(!api, 'Seed session unavailable.');

    const name = `browser-widget-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: [`${ALLOWED_ORIGIN}/`] });
    toCleanup.push(project);

    // Widget key bound to the project, allow-listing ONLY the allowed origin.
    const key = await createWidgetKey(api!, project.id, [ALLOWED_ORIGIN]);

    const html = widgetPage(API_URL, key.rawKey);
    allowedServer = await startServer(html, ALLOWED_PORT);
    blockedServer = await startServer(html, BLOCKED_PORT);

    // Fresh (unauthenticated) context — the widget surface is credential-free.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // ---- Allowed origin: a cross-origin POST succeeds (201) ----
    await page.goto(ALLOWED_ORIGIN);
    const description = `widget-allowed-${uniqueSuffix()}`;
    const allowedResult = await page.evaluate(
      async ({ apiUrl, projectKey, description }) => {
        try {
          const res = await fetch(`${apiUrl}/api/v1/widget/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Project-Key': projectKey },
            body: JSON.stringify({
              description,
              severity: 'minor',
              pageUrl: window.location.href,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              userAgent: navigator.userAgent,
            }),
          });
          return { ok: true, status: res.status } as const;
        } catch (e) {
          return { ok: false, error: String(e) } as const;
        }
      },
      { apiUrl: API_URL, projectKey: key.rawKey, description },
    );
    expect(allowedResult.ok, `allowed-origin fetch error: ${allowedResult.error ?? ''}`).toBe(true);
    expect(allowedResult.status).toBe(201);

    // The annotation exists via the API — the cross-origin write landed.
    await expect
      .poll(async () => (await listAnnotations(api!, project.id)).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // ---- Non-allowed origin: the same POST is blocked by CORS ----
    await page.goto(BLOCKED_ORIGIN);
    const blockedResult = await page.evaluate(
      async ({ apiUrl, projectKey }) => {
        try {
          const res = await fetch(`${apiUrl}/api/v1/widget/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Project-Key': projectKey },
            body: JSON.stringify({
              description: 'should-be-blocked',
              severity: 'minor',
              pageUrl: window.location.href,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              userAgent: navigator.userAgent,
            }),
          });
          return { ok: true, status: res.status } as const;
        } catch (e) {
          return { ok: false, error: String(e) } as const;
        }
      },
      { apiUrl: API_URL, projectKey: key.rawKey },
    );
    // The browser blocks the response (ACAO withheld for a disallowed origin,
    // plus a server 403 hard-reject). A browser fetch surfaces this as a
    // network/CORS failure (ok=false); if a status leaks through it MUST be
    // the 403 hard-reject, never a 2xx.
    if (blockedResult.ok) {
      expect(blockedResult.status, 'non-allowed origin must not succeed').toBe(403);
    } else {
      expect(blockedResult.ok).toBe(false);
    }

    await ctx.close();
  });

  test('(e) the embed SDK <script> loads and Pinpoint.init runs cross-origin', async ({
    browser,
  }) => {
    test.skip(!api, 'Seed session unavailable.');

    const name = `browser-widget-sdk-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: [`${ALLOWED_ORIGIN}/`] });
    toCleanup.push(project);
    const key = await createWidgetKey(api!, project.id, [ALLOWED_ORIGIN]);

    // Reuse the already-running allowed-origin server if present; otherwise
    // start one bound to this key.
    const html = widgetPage(API_URL, key.rawKey);
    if (!allowedServer) allowedServer = await startServer(html, ALLOWED_PORT);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(ALLOWED_ORIGIN);

    // The cross-origin embed SDK must load and Pinpoint.init must run.
    await expect
      .poll(async () => page.evaluate(() => (window as any).__pinpointReady === true), {
        timeout: 10_000,
      })
      .toBe(true);
    await expect(page.locator('#pinpoint-widget-host')).toHaveCount(1);

    await ctx.close();
  });
});
