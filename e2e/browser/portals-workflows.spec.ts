/**
 * Real-UI: Client Portals + Workflow Automation (rules, SLA policies).
 *
 *   • populated flows run as the seed account (org owner): create / toggle /
 *     rename / delete rules, create / delete SLA policies, create / (edit) /
 *     delete portals — all through the real forms; rows are looked up by a
 *     unique name so re-runs and other specs never collide.
 *   • empty states use a brand-new account (empty org) logged in through the
 *     real form, so they are deterministic.
 *
 * Portal EDIT needs `PATCH /api/v1/portals/:id`; when the API under test does
 * not have that route yet the edit test is skipped with an explicit reason.
 */
import { type Page, expect, test } from '@playwright/test';

import { DEMO_PASSWORD, ensureUser } from './demo.js';
import {
  type ApiClient,
  type CreatedProject,
  createProject,
  deleteProject,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

test.describe('portals + workflows', () => {
  let api: ApiClient | null;
  const projects: CreatedProject[] = [];

  test.beforeAll(async () => {
    api = await makeApiClient();
  });

  test.afterAll(async () => {
    if (api) {
      for (const p of projects) await deleteProject(api, p).catch(() => {});
      await api.dispose();
    }
  });

  const row = (page: Page, role: string, name: string) =>
    page.locator(`[data-role="${role}"]`).filter({ hasText: name });

  // ---------------------------------------------------------------- rules
  test('automation rule: create → toggle → rename → delete', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `Rule ${uniqueSuffix()}`;
    const renamed = `${name} (renamed)`;

    await page.goto('/workflows');
    await expect(page.getByRole('heading', { name: 'Workflow Automation', exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ Create Rule' }).first().click();
    const form = page.locator('[data-role="rule-form"]');
    await expect(form).toBeVisible();

    // Validation: empty name, then invalid JSON — nothing is posted.
    await form.getByRole('button', { name: 'Save Rule' }).click();
    await expect(form.locator('[data-role="rule-name-error"]')).toContainText('name');
    await form.locator('[data-role="rule-name"]').fill(name);
    await form.locator('[data-role="rule-params"]').fill('{not json');
    await form.getByRole('button', { name: 'Save Rule' }).click();
    await expect(form.locator('[data-role="rule-params-error"]')).toContainText('valid JSON');

    await form.locator('[data-role="rule-action"]').selectOption('notify');
    await form.locator('[data-role="rule-params"]').fill('{"channel":"email"}');
    await form.getByRole('button', { name: 'Save Rule' }).click();

    const item = row(page, 'rule-row', name);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item).toContainText('Annotation created → Notify');
    await expect(form).toBeHidden();

    // Toggle off (persists server-side).
    const toggle = item.locator('[data-role="rule-toggle"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await expect(row(page, 'rule-row', name).locator('[data-role="rule-toggle"]')).toHaveAttribute('aria-checked', 'false');

    // Rename inline.
    await row(page, 'rule-row', name).getByRole('button', { name: /^Rename/ }).click();
    await page.locator('[data-role="rule-edit-input"]').fill(renamed);
    await page.locator('[data-role="rule-edit-save"]').click();
    await expect(row(page, 'rule-row', renamed)).toBeVisible();

    // Delete needs a second, explicit confirmation.
    const renamedRow = row(page, 'rule-row', renamed);
    await renamedRow.locator('[data-role="rule-delete"]').click();
    await expect(renamedRow).toBeVisible();
    await renamedRow.locator('[data-role="rule-delete-confirm"]').click();
    await expect(row(page, 'rule-row', renamed)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Automation Rules', exact: true })).toBeVisible();
    await expect(row(page, 'rule-row', renamed)).toHaveCount(0);
  });

  // ------------------------------------------------------------------ SLA
  test('SLA policy: validate → create → delete', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `SLA ${uniqueSuffix()}`;
    await page.goto('/workflows');
    await page.getByRole('button', { name: '+ Create SLA' }).first().click();
    const form = page.locator('[data-role="sla-form"]');
    await form.locator('[data-role="sla-name"]').fill(name);
    await form.locator('[data-role="sla-response"]').fill('10');
    await form.locator('[data-role="sla-resolution"]').fill('2');
    await form.getByRole('button', { name: 'Save SLA' }).click();
    await expect(form.locator('[data-role="sla-form-error"]')).toContainText('cannot be shorter');

    await form.locator('[data-role="sla-severity"]').selectOption('major');
    await form.locator('[data-role="sla-response"]').fill('4');
    await form.locator('[data-role="sla-resolution"]').fill('72');
    await form.getByRole('button', { name: 'Save SLA' }).click();

    const item = row(page, 'sla-row', name);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item).toContainText('Respond within 4 hours · resolve within 3 days');

    await item.locator('[data-role="sla-delete"]').click();
    await item.locator('[data-role="sla-delete-confirm"]').click();
    await expect(row(page, 'sla-row', name)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'SLA Policies', exact: true })).toBeVisible();
    await expect(row(page, 'sla-row', name)).toHaveCount(0);
  });

  // --------------------------------------------------------------- portals
  test('portal: create (slug auto-fill, validation) → delete', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const suffix = uniqueSuffix().toLowerCase();
    const project = await createProject(api!, { name: `portal-proj-${suffix}`, urls: ['https://example.com/'] });
    projects.push(project);
    const title = `Portal ${suffix}`;

    await page.goto('/portals');
    await expect(page.getByRole('heading', { name: 'Client Portals', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '+ Create Portal' }).first().click();
    const form = page.locator('[data-role="create-form"]');

    // Empty submit → inline field errors, no request.
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('[data-role="err-projectId"]')).toBeVisible();
    await expect(page.locator('[data-role="err-title"]')).toBeVisible();
    await expect(page.locator('[data-role="err-slug"]')).toBeVisible();

    // The project list is filled asynchronously by the sidebar.
    await expect(form.locator('[data-role="project-select"] option', { hasText: project.name })).toHaveCount(1, { timeout: 10_000 });
    await form.locator('[data-role="project-select"]').selectOption({ label: project.name });
    await form.locator('#portal-title').fill(title);
    await expect(form.locator('#portal-slug')).toHaveValue(/^portal-/);
    await form.locator('#portal-welcome').fill('Welcome, client');
    await form.getByRole('button', { name: 'Create' }).click();

    const item = row(page, 'portal-row', title);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item).toContainText(project.name);
    await expect(item.locator('.pp-badge')).toHaveText('Active');

    // Deactivate (needs PATCH) is covered in the edit test; delete here.
    await item.locator('[data-role="portal-delete"]').click();
    await item.locator('[data-role="portal-delete-confirm"]').click();
    await expect(row(page, 'portal-row', title)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Client Portals', exact: true })).toBeVisible();
    await expect(row(page, 'portal-row', title)).toHaveCount(0);
  });

  test('portal: edit title and toggle active', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const suffix = uniqueSuffix().toLowerCase();
    const project = await createProject(api!, { name: `portal-edit-${suffix}`, urls: ['https://example.com/'] });
    projects.push(project);
    const created = await api!.ctx.post('/api/v1/portals', {
      data: { projectId: project.id, title: `Edit ${suffix}`, slug: `edit-${suffix}` },
    });
    expect(created.status()).toBe(201);
    const portal = ((await created.json()) as { portal: { id: string } }).portal;

    const probe = await api!.ctx.patch(`/api/v1/portals/${portal.id}`, { data: { active: true } });
    test.skip(probe.status() === 404, 'API has no PATCH /portals/:id yet (see report: server diff).');
    expect(probe.status()).toBe(200);

    const next = `Edited ${suffix}`;
    await page.goto('/portals');
    const item = row(page, 'portal-row', `Edit ${suffix}`);
    await item.locator('[data-role="portal-edit"]').click();
    await expect(page.locator('#portal-slug')).toBeDisabled();
    await page.locator('#portal-title').fill(next);
    await page.locator('[data-role="form-submit"]').click();
    await expect(row(page, 'portal-row', next)).toBeVisible({ timeout: 10_000 });

    const toggle = row(page, 'portal-row', next).locator('[data-role="portal-toggle"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await expect(row(page, 'portal-row', next).locator('.pp-badge')).toHaveText('Inactive');
    await api!.ctx.delete(`/api/v1/portals/${portal.id}`);
  });

  // ---------------------------------------------------------- empty states
  test('empty states in a brand-new workspace (workflows, portals, reports)', async ({ browser }) => {
    const user = await ensureUser({
      email: `empty.${uniqueSuffix().toLowerCase()}@acmestudio.dev`,
      name: 'Empty Org',
      pro: true,
    });
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await ctx.newPage();
      await page.goto('/auth');
      await page.locator('input[name="email"]').fill(user.email);
      await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
      await page.getByRole('button', { name: 'Log In' }).click();
      await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });

      await page.goto('/workflows');
      const rules = page.locator('[data-role="rules-list"] .pp-empty-state');
      await expect(rules).toBeVisible({ timeout: 15_000 });
      await expect(rules).toContainText('No automation rules');
      await expect(rules.locator('svg[aria-hidden="true"]')).toBeVisible();
      await expect(page.locator('[data-role="sla-list"] .pp-empty-state')).toContainText('No SLA policies');
      // The empty-state CTA is the primary next step: it opens the form.
      await rules.getByRole('button', { name: '+ Create Rule' }).click();
      await expect(page.locator('[data-role="rule-form"]')).toBeVisible();

      await page.goto('/portals');
      const portals = page.locator('[data-role="portal-list"] .pp-empty-state');
      await expect(portals).toBeVisible({ timeout: 15_000 });
      await expect(portals).toContainText('No client portals');
      await portals.getByRole('button', { name: '+ Create Portal' }).click();
      await expect(page.locator('[data-role="portal-form"]')).toBeVisible();

      await page.goto('/reports');
      const reports = page.locator('[data-slot="cards"] .pp-empty-state');
      await expect(reports).toBeVisible({ timeout: 15_000 });
      await expect(reports).toContainText('No report data yet');
      await expect(page.locator('body')).not.toContainText('null%');
      await reports.getByRole('button', { name: 'Go to projects' }).click();
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await ctx.close();
      await user.dispose();
    }
  });
});
