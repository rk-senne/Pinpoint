/**
 * One-time UI login for the real-browser specs.
 *
 * This is the ONLY place the browser suite logs in through the UI. It fills
 * the real `/auth` login form (the genuine user flow) with
 * `FL_E2E_EMAIL` / `FL_E2E_PASSWORD`, waits for the post-login redirect to
 * `/`, then saves the authenticated `storageState` to `.auth/browser.json`.
 * Every `browser/*.spec.ts` reuses that state via `test.use({ storageState })`
 * configured on the `browser` project, so no spec logs in again — keeping the
 * suite under the API's 5-logins/min-per-(IP,email) auth rate limit.
 *
 * Logging in THROUGH the browser (rather than injecting the seed cookies) is
 * deliberate: the seed cookies are pinned to `127.0.0.1`, but the Dashboard
 * runs on `localhost:5173` and calls `/api` through the Vite proxy on that
 * SAME origin. A UI login mints cookies for the correct origin.
 */
import { expect, test as setup } from '@playwright/test';

import { BROWSER_STORAGE_STATE } from '../playwright.config.js';
import { SEED_EMAIL, SEED_PASSWORD, API_URL } from './helpers.js';

setup('authenticate through the UI', async ({ page, request }) => {
  setup.skip(!SEED_EMAIL || !SEED_PASSWORD, 'Set FL_E2E_EMAIL + FL_E2E_PASSWORD.');

  // Bail out cleanly if the stack is down so the browser suite skips rather
  // than hard-fails on a developer box with no services running.
  const health = await request.get(`${API_URL}/health`, { timeout: 3_000 }).catch(() => null);
  setup.skip(!health?.ok(), `API not reachable at ${API_URL}.`);

  await page.goto('/auth');

  // The AuthPage renders a login form with name= inputs and a submit button
  // whose text is "Log In" (see dashboard/src/pages/AuthPage.ts + the
  // #tpl-auth-page template in index.html).
  await page.locator('input[name="email"]').fill(SEED_EMAIL);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).click();

  // On success the AuthPage navigates to `/`. Assert the URL left `/auth`.
  await expect(page).toHaveURL(/\/$|\/#?$|\/(\?.*)?$/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/auth/);

  await page.context().storageState({ path: BROWSER_STORAGE_STATE });
});
