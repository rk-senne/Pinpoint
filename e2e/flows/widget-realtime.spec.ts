/**
 * Flow: a dashboard tab sits open on a project; a visitor submits feedback
 * through the embedded widget on a host page; the item appears in the open
 * dashboard WITHOUT a reload (Socket.IO `annotation.created`).
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
  makeApiClient,
  uniqueSuffix,
} from '../browser/helpers.js';

const HOST_PORT = 5451;
const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`;

function hostPage(projectKey: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title></head>
<body><main><h1>Customer site</h1><p>Some page content.</p></main>
<script src="${API_URL}/widget/pinpoint-widget.js"></script>
<script>window.Pinpoint.init({ projectKey: ${JSON.stringify(projectKey)}, apiUrl: ${JSON.stringify(API_URL)} });</script>
</body></html>`;
}

test.describe('widget → dashboard realtime', () => {
  let api: ApiClient | null;
  let project: CreatedProject | null = null;
  let host: Server | null = null;

  test.beforeAll(async () => {
    api = await makeApiClient();
    if (!api) return;
    project = await createProject(api, { name: `rt-flow-${uniqueSuffix()}`, urls: [`${HOST_ORIGIN}/`] });
    const key = await createWidgetKey(api, project.id, [HOST_ORIGIN]);
    const html = hostPage(key.rawKey);
    host = createServer((_q, r) => {
      r.setHeader('Content-Type', 'text/html; charset=utf-8');
      r.end(html);
    });
    await new Promise<void>((res, rej) => {
      host!.on('error', rej);
      host!.listen(HOST_PORT, '127.0.0.1', res);
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => (host ? host.close(() => r()) : r()));
    if (api && project) await deleteProject(api, project).catch(() => {});
    await api?.dispose();
  });

  test('a widget submission shows up in the open project view without reload', async ({ page, browser }) => {
    test.skip(!api || !project, 'Seed session unavailable.');

    // Dashboard tab, already loaded and subscribed.
    await page.goto(`/projects/${project!.id}`);
    await expect(page.getByRole('heading', { name: project!.name }).first()).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });

    // Visitor on the host page (separate, logged-out context).
    const text = `Realtime widget feedback ${uniqueSuffix()}`;
    const visitorCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await visitorCtx.addInitScript(() => {
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
        return original.call(this, { ...init, mode: 'open' });
      };
    });
    const visitor = await visitorCtx.newPage();
    await visitor.goto(`${HOST_ORIGIN}/`);
    await visitor.locator('#pinpoint-widget-host .pinpoint-trigger').click();
    await visitor.getByRole('textbox', { name: 'Description' }).fill(text);
    await visitor.getByRole('button', { name: 'Submit' }).click();
    await expect(visitor.getByRole('status')).toContainText('Thank you!');
    await visitorCtx.close();

    // The open dashboard receives it live — same document, no navigation.
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });
});
