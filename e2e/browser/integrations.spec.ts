/**
 * Real-UI: connect an integration and finish its setup on /integrations.
 *
 * The API's outbound HTTP is https-only and blocks private addresses (safeFetch),
 * so a fake provider cannot be hosted locally. What is real here: the dashboard,
 * the API, Postgres and the PATCH /integrations/:provider config validation.
 * What is faked with `page.route`: the provider-facing hops — the OAuth
 * `redirectUrl` returned by /connect, the 501 for an unconfigured provider, and
 * GET /:provider/targets (which would call the real provider with a dummy token).
 * Per-provider target parsing and the OAuth callback are covered by the server
 * route tests (integrations.targets.routes.test.ts).
 *
 * Uses ClickUp/Asana (unused by other specs) and removes what it creates.
 */
import { expect, test } from '@playwright/test';

import { type ApiClient, makeApiClient } from './helpers.js';

test.describe('integrations page', () => {
  let api: ApiClient | null;

  test.beforeAll(async () => {
    api = await makeApiClient();
  });

  test.afterEach(async () => {
    if (!api) return;
    for (const p of ['clickup', 'asana']) await api.ctx.delete(`/api/v1/integrations/${p}`).catch(() => {});
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('Connect hands the browser to the provider authorize URL (no fake "connected" toast)', async ({ page }) => {
    // Fulfil the provider hop on the dashboard origin so no real network is needed.
    await page.route('**/api/v1/integrations/asana/connect', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirectUrl: '/__fake-provider/authorize?state=abc' }),
      }),
    );
    await page.route('**/__fake-provider/authorize**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1 id="fake-provider">Fake provider</h1>' }),
    );

    await page.goto('/integrations');
    const connect = page.locator('[data-connect="asana"]');
    await expect(connect).toBeVisible({ timeout: 15_000 });
    await connect.click();

    await expect(page.locator('#fake-provider')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/__fake-provider/authorize?state=abc');
  });

  test('an unconfigured provider shows the admin message', async ({ page }) => {
    await page.route('**/api/v1/integrations/clickup/connect', (route) =>
      route.fulfill({
        status: 501,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'not configured' } }),
      }),
    );
    await page.goto('/integrations');
    await page.locator('[data-connect="clickup"]').click();
    await expect(page.locator('[data-provider="clickup"] [data-role="connect-not-configured"]')).toHaveText(
      'Ask your admin to configure ClickUp — see INTEGRATIONS_SETUP.md',
    );
  });

  test('Finish setup: pick a target, it is validated + saved by the real API', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    // Token path = what the OAuth callback leaves behind: a connected integration with no target yet.
    const connected = await api!.ctx.post('/api/v1/integrations/clickup/connect', {
      data: { accessToken: 'pk_dummy_e2e_token', config: {} },
    });
    expect(connected.status()).toBe(201);

    await page.route('**/api/v1/integrations/clickup/targets', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          targets: [
            { id: 'l1', label: 'Team / Space / Bugs', config: { listId: 'l1' } },
            { id: 'l2', label: 'Team / Space / Feedback', config: { listId: 'l2' } },
          ],
        }),
      }),
    );

    // The OAuth callback lands here; the page must jump straight into the picker.
    await page.goto('/integrations?connected=clickup');
    const select = page.locator('[data-provider="clickup"] [data-role="target-select"]');
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/integrations$/); // one-shot params stripped

    await select.selectOption({ label: 'Team / Space / Feedback' });
    await page.locator('[data-provider="clickup"] [data-role="target-save"]').click();

    // The card flips from "Finish setup" to "Change target".
    await expect(page.locator('[data-provider="clickup"] [data-setup]')).toHaveText('Change target', { timeout: 10_000 });

    // Real server state: the validated config was persisted (and no secrets are exposed).
    const list = await api!.ctx.get('/api/v1/integrations');
    const body = (await list.json()) as { integrations: Array<{ provider: string; config: Record<string, unknown> }> };
    const entry = body.integrations.find((i) => i.provider === 'clickup');
    expect(entry?.config).toMatchObject({ listId: 'l2' });
    expect(JSON.stringify(body)).not.toContain('pk_dummy_e2e_token');

    // The real endpoint rejects configs that fail the strict per-provider schema.
    const bad = await api!.ctx.patch('/api/v1/integrations/clickup', { data: { config: { listId: '../x' } } });
    expect(bad.status()).toBe(400);
  });
});
