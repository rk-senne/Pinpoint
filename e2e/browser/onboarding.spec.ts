/**
 * Real-UI: onboarding wizard (d).
 *
 * The wizard (`/onboarding`, mounted by OnboardingWizard.ts) is a 4-step
 * stepper. This spec picks a project (created via API), issues a project-bound
 * widget key, and asserts the generated embed snippet contains both
 * `Pinpoint.init` and the `pk_widget_` key.
 *
 * Runs on the shared browser storageState and loads /onboarding with a full
 * page navigation: the Dashboard rehydrates its double-submit CSRF token from
 * the readable `fl_csrf` cookie, so the wizard's `POST /api-keys` mutation
 * must succeed after a hard reload (regression guard for that fix).
 */
import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  SEED_EMAIL,
  SEED_PASSWORD,
  createProject,
  deleteProject,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

test.describe('onboarding wizard', () => {
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

  test('(d) issues a widget key and shows a snippet with Pinpoint.init + pk_widget_', async ({
    page,
  }) => {
    test.skip(!api, 'Seed session unavailable.');
    test.skip(!SEED_EMAIL || !SEED_PASSWORD, 'Seed credentials required.');

    const name = `browser-onboard-${uniqueSuffix()}`;
    const project = await createProject(api!, { name, urls: ['https://example.com/'] });
    toCleanup.push(project);

    // Hard navigation on the saved session: the dashboard reads the CSRF
    // token from the fl_csrf cookie, so mutations work after a full page
    // load (this used to need a fresh in-page login).
    await page.goto('/onboarding');

    // Step 1 — pick the existing project from the select, then continue.
    const select = page.locator('#onboarding-project-select');
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => select.locator(`option[value="${project.id}"]`).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    await select.selectOption(project.id);
    await page.getByRole('button', { name: 'Use this project' }).click();

    // Step 2 — issue the widget key.
    const issueBtn = page.getByRole('button', { name: 'Issue widget key' });
    await expect(issueBtn).toBeVisible({ timeout: 10_000 });
    await issueBtn.click();

    // Step 3 — the snippet textarea shows the embed code.
    const snippet = page.locator('#onboarding-snippet');
    await expect(snippet).toBeVisible({ timeout: 15_000 });
    const value = await snippet.inputValue();
    expect(value).toContain('Pinpoint.init');
    expect(value).toContain('pk_widget_');
    expect(value).toContain('/widget/pinpoint-widget.js');
  });
});
