/**
 * Flow: Developer page → create an org API key (shown once) → use it as a
 * Bearer against the REST API → revoke it in the UI → the same request is 401.
 */
import { expect, test } from '@playwright/test';

import { API_URL, uniqueSuffix } from '../browser/helpers.js';

test('api keys: create in UI, use as bearer, revoke, then 401', async ({ page, request }) => {
  const name = `flow-key-${uniqueSuffix()}`;
  await page.goto('/developer');
  await page.getByRole('textbox', { name: 'Key name' }).fill(name);
  await page.getByRole('button', { name: 'Create key' }).click();

  const raw = (await page.locator('[data-role="api-key-raw"]').textContent()) ?? '';
  expect(raw).toMatch(/^pk_[0-9a-f]{20,}$/);
  const row = page.locator('tr', { hasText: name });
  await expect(row).toContainText('Active');
  // Only a prefix is ever listed, never the raw key.
  await expect(page.locator('[data-role="api-key-rows"]')).not.toContainText(raw);

  const bearer = { headers: { Authorization: `Bearer ${raw}` } };
  const ok = await request.get(`${API_URL}/api/v1/projects`, bearer);
  expect(ok.status()).toBe(200);
  // Standard keys cannot reach account / key-management routes.
  expect((await request.get(`${API_URL}/api/v1/api-keys`, bearer)).status()).toBeGreaterThanOrEqual(401);

  await row.getByRole('button', { name: `Revoke ${name}` }).click();
  await expect(row).toContainText('Revoked');

  const revoked = await request.get(`${API_URL}/api/v1/projects`, bearer);
  expect(revoked.status()).toBe(401);
});
