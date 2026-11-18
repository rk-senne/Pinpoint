/**
 * Real-UI: "Send to…" task-delivery menu (g).
 *
 * The SendToMenu (components/SendToMenu.ts) is mounted into an annotation's
 * detail panel. Opening it lists the org's connected task-tracker
 * integrations (from `GET /integrations`) OR shows an empty state when none
 * are connected. This spec makes no real provider calls — it only asserts the
 * menu renders one of those two valid states.
 */
import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  createAnnotation,
  createProject,
  deleteProject,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

test.describe('send-to menu', () => {
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

  test('(g) shows connected integrations or the empty state', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `browser-sendto-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);
    await createAnnotation(api!, project.id, project.pages[0].url, {
      body: `sendto-annotation-${uniqueSuffix()}`,
      type: 'note',
      severity: 'major',
    });

    await page.goto(`/projects/${project.id}`);

    // Open the first annotation to reveal the detail panel + Send-to menu.
    const listBody = page.locator('[data-role="list-body"]');
    await expect(listBody).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => listBody.locator('tr').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await listBody.locator('tr').first().click();

    const detail = page.locator('[data-section="detail"]');
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // The "Send to…" button is rendered by SendToMenu.
    const sendToButton = detail.locator('[data-role="send-to-button"]');
    await expect(sendToButton).toBeVisible({ timeout: 10_000 });
    await sendToButton.click();

    const listItem = detail.locator('[data-role="send-to-list"]');
    await expect(listItem).toBeVisible({ timeout: 10_000 });

    // Either the empty-state row OR at least one provider option must appear.
    const emptyState = detail.locator('[data-role="send-to-empty"]');
    const providerOption = detail.locator('[data-role="send-to-option"]');
    await expect
      .poll(
        async () => (await emptyState.count()) + (await providerOption.count()),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
