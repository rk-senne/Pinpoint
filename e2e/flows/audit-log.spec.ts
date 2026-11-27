/**
 * Flow: perform a few audited actions, open the audit log in the Developer
 * page and filter it by action prefix.
 */
import { expect, test } from '@playwright/test';

import { createSharedLink, createProject, deleteProject, makeApiClient, uniqueSuffix } from '../browser/helpers.js';

test('audit log: actions show up and the prefix filter narrows them', async ({ page }) => {
  const api = await makeApiClient();
  test.skip(!api, 'Seed session unavailable.');
  const project = await createProject(api!, { name: `audit-flow-${uniqueSuffix()}`, urls: ['https://example.com/'] });
  try {
    await createSharedLink(api!, project.id, { allowFeedback: true });
    const key = await api!.ctx.post('/api/v1/api-keys', { data: { name: `audit-key-${uniqueSuffix()}` } });
    expect(key.status()).toBe(201);

    await page.goto('/developer');
    const rows = page.locator('[data-role="audit-rows"] tr');
    await expect(rows.first()).toBeVisible();

    const prefix = page.getByRole('textbox', { name: 'Action prefix' });
    await prefix.fill('api_key.');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(rows.filter({ hasText: 'api_key.created' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'share_link.' })).toHaveCount(0);

    await prefix.fill('share_link.');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(rows.filter({ hasText: 'share_link.' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'api_key.' })).toHaveCount(0);

    await prefix.fill('no_such_prefix.');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.locator('[data-role="audit-empty"]')).toBeVisible();
  } finally {
    await deleteProject(api!, project).catch(() => {});
    await api!.dispose();
  }
});
