/**
 * Real-UI: dashboard project list (b) + project view detail (c).
 *
 * Drives the live Dashboard with the authenticated storageState minted by
 * `auth.setup.ts`. Fixtures (project, annotations, shared link, guest
 * feedback) are created through the REST API with the seed account's bearer
 * token so each spec is self-contained and idempotent. Projects are deleted
 * in `afterEach`.
 */
import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  createAnnotation,
  createProject,
  createSharedLink,
  deleteProject,
  listAnnotations,
  makeApiClient,
  submitGuestFeedback,
  uniqueSuffix,
} from './helpers.js';

test.describe('dashboard UI', () => {
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

  test('(b) a project created via API appears in the sidebar', async ({ page }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `browser-sidebar-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);

    await page.goto('/');

    // Scope to the sidebar navigation region to avoid matching the same name
    // in the DashboardHome "recent projects" list. The sidebar row carries
    // `[data-role="name"]` (tpl-project-list-item).
    const nav = page.getByLabel('Main navigation');
    await expect(
      nav.locator('[data-role="name"]', { hasText: name }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('(c) project view reads the { data } envelope, shows detail + diagnostics', async ({
    page,
  }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `browser-projview-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);
    const pageUrl = project.pages[0].url;

    const authoredBody = `authored-annotation-${uniqueSuffix()}`;
    await createAnnotation(api!, project.id, pageUrl, {
      body: authoredBody,
      type: 'note',
      severity: 'critical',
      consoleLogs: [
        {
          level: 'error',
          message: 'Browser-spec console error line',
          timestamp: new Date().toISOString(),
        },
      ],
      jsErrors: [
        {
          kind: 'error',
          message: 'Browser-spec uncaught error',
          timestamp: new Date().toISOString(),
        },
      ],
    });

    await page.goto(`/projects/${project.id}`);

    // The list is populated from `GET /projects/:id/annotations` — proving the
    // dashboard reads the `{ data }` envelope (tpl-project-view-list-row).
    const listBody = page.locator('[data-role="list-body"]');
    await expect(listBody).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => listBody.locator('tr').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Open the annotation's detail panel.
    await page.getByText(authoredBody).first().click();
    const detail = page.locator('[data-section="detail"]');
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // "Console & errors" diagnostics (DiagnosticsPanel, Mission C2) renders
    // because the annotation carries consoleLogs + jsErrors.
    await expect(
      detail.locator('[data-role="diagnostics-panel"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(detail.getByText('Console & errors')).toBeVisible();
  });

  test('(c) guest submission is flagged "Unverified guest" in the dashboard', async ({
    page,
  }) => {
    test.skip(!api, 'Seed session unavailable.');
    const name = `browser-guest-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);
    const pageUrl = project.pages[0].url;

    // A guest submission via the public shared-link feedback endpoint produces
    // an `isGuest=true` annotation the dashboard should flag.
    const link = await createSharedLink(api!, project.id, { allowFeedback: true });
    const guestStatus = await submitGuestFeedback(link.id, pageUrl, {
      name: 'Guest Reviewer',
      description: `guest-annotation-${uniqueSuffix()}`,
    });
    expect(guestStatus, 'guest feedback POST should be 201').toBe(201);

    // The annotation exists in the list.
    await expect
      .poll(async () => (await listAnnotations(api!, project.id)).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    await page.goto(`/projects/${project.id}`);
    const listBody = page.locator('[data-role="list-body"]');
    await expect(listBody).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => listBody.locator('tr').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // The guest row must carry an "Unverified guest" badge (Mission A7.4).
    await expect(page.getByText('Unverified guest').first()).toBeVisible({ timeout: 15_000 });
  });
});
