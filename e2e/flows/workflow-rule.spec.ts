/**
 * Flow: Workflows page → create a rule (annotation.created, severity=critical
 * → set status in_progress) in the UI → a critical annotation created through
 * the API is moved to in_progress by the rule engine, a minor one is left
 * alone → the rule is deleted in the UI.
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
} from '../browser/helpers.js';

test.describe('workflow rule', () => {
  let api: ApiClient | null;
  let project: CreatedProject | null = null;

  test.beforeAll(async () => {
    api = await makeApiClient();
    if (api) {
      project = await createProject(api, { name: `wf-flow-${uniqueSuffix()}`, urls: ['https://example.com/'] });
    }
  });

  test.afterAll(async () => {
    if (api && project) await deleteProject(api, project).catch(() => {});
    await api?.dispose();
  });

  async function statusOf(id: string): Promise<string | undefined> {
    const res = await api!.ctx.get(`/api/v1/projects/${project!.id}/annotations`);
    const body = (await res.json()) as { data: Array<{ id: string; status: string }> };
    return body.data.find((a) => a.id === id)?.status;
  }

  test('a critical annotation is auto-moved to in_progress; a minor one is not', async ({ page }) => {
    test.skip(!api || !project, 'Seed session unavailable.');
    const name = `Critical → in progress ${uniqueSuffix()}`;

    await page.goto('/workflows');
    await expect(page.getByRole('heading', { name: 'Workflow Automation', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '+ Create Rule' }).first().click();
    const form = page.locator('[data-role="rule-form"]');
    await form.locator('[data-role="rule-name"]').fill(name);
    await form.locator('[data-role="rule-trigger"]').selectOption('annotation.created');
    await form.locator('[data-role="rule-severity"]').selectOption('critical');
    await form.locator('[data-role="rule-action"]').selectOption('set_status');
    await form.locator('[data-role="rule-params"]').fill('{"status":"in_progress"}');
    await form.getByRole('button', { name: 'Save Rule' }).click();

    const item = page.locator('[data-role="rule-row"]').filter({ hasText: name });
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item).toContainText('severity = critical');

    try {
      const minor = await createAnnotation(api!, project!.id, 'https://example.com/', { severity: 'minor', body: 'flow minor' });
      const critical = await createAnnotation(api!, project!.id, 'https://example.com/', { severity: 'critical', body: 'flow critical' });

      // The engine runs detached after the create returns → poll.
      await expect.poll(() => statusOf(critical.id), { timeout: 20_000, intervals: [250, 500, 1000] }).toBe('in_progress');
      // Same trigger, same moment: the non-matching item stays untouched.
      expect(await statusOf(minor.id)).toBe('active');
    } finally {
      // Always remove the rule so it cannot touch other specs' data.
      await page.goto('/workflows');
      const row = page.locator('[data-role="rule-row"]').filter({ hasText: name });
      await row.locator('[data-role="rule-delete"]').click();
      await row.locator('[data-role="rule-delete-confirm"]').click();
      await expect(page.locator('[data-role="rule-row"]').filter({ hasText: name })).toHaveCount(0);
    }
  });
});
