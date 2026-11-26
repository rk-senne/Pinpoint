/**
 * Flow: forgot password → emailed link → new password → log in with it.
 *
 * Drives the real dashboard UI. The reset link is read from the mail sink
 * (Mailpit when FL_MAIL_API is set, else the dev stack's mail.log). Uses a
 * throwaway user so the shared seed account's password is never touched.
 */
import { expect, test } from '@playwright/test';

import { ensureUser } from '../browser/demo.js';
import { API_URL, extractLink, mailMarker, uniqueSuffix, waitForMail } from '../browser/helpers.js';

// Fresh, logged-out browser context: this flow starts from the login form.
test.use({ storageState: { cookies: [], origins: [] } });

test('password reset: request in UI → mail link → new password → log in', async ({ page, request }) => {
  const email = `reset-${uniqueSuffix()}@example.test`;
  const oldPassword = 'Old-Passw0rd-Flow-1!';
  const newPassword = 'New-Passw0rd-Flow-2!';
  const user = await ensureUser({ email, name: 'Reset Flow', password: oldPassword });
  await user.dispose();

  // 1. Request the link from the login page.
  await page.goto('/auth');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/reset-password$/);
  const since = await mailMarker();
  await page.locator('input[name="email"]').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'reset link has been sent' })).toBeVisible();

  // 2. The emailed link points at the dashboard's reset page.
  const mail = await waitForMail({ to: email, since, subject: /reset/i });
  const link = extractLink(mail.body, /^\/reset-password\/[^/]+$/);

  // 3. Set the new password.
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.locator('input[name="password"]').fill(newPassword);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // 4. The old password no longer works; the new one does.
  const bad = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email, password: oldPassword },
  });
  expect(bad.status()).toBe(401);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(newPassword);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).not.toHaveURL(/\/(auth|login)/, { timeout: 15_000 });

  // 5. A reset link is single-use.
  const replay = await request.post(`${API_URL}/api/v1/auth/reset-password/${link.split('/').pop()}`, {
    data: { password: 'Another-Passw0rd-3!' },
  });
  expect(replay.ok()).toBe(false);
});
