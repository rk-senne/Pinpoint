/**
 * Flow: Settings → Profile → change email (needs the current password) →
 * confirmation mail to the NEW address → confirm link → every old session is
 * revoked → log in with the new email.
 */
import { expect, test } from '@playwright/test';

import { ensureUser } from '../browser/demo.js';
import { API_URL, extractLink, mailMarker, uniqueSuffix, waitForMail } from '../browser/helpers.js';

test.use({ storageState: { cookies: [], origins: [] } });

test('email change: confirm link switches the login email and revokes old sessions', async ({ page, request }) => {
  const suffix = uniqueSuffix();
  const oldEmail = `chg-old-${suffix}@example.test`;
  const newEmail = `chg-new-${suffix}@example.test`;
  const password = 'Chg-Passw0rd-Flow-1!';
  const user = await ensureUser({ email: oldEmail, name: 'Change Flow', password });
  const oldBearer = user.token;
  await user.dispose();

  // Log in through the UI.
  await page.goto('/auth');
  await page.locator('input[name="email"]').fill(oldEmail);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).not.toHaveURL(/\/(auth|login)/, { timeout: 15_000 });

  // Change the email on the profile tab.
  await page.goto('/settings');
  const emailInput = page.locator('[data-role="profile-email"]');
  await expect(emailInput).toHaveValue(oldEmail);

  // A wrong current password is rejected and nothing is mailed.
  await emailInput.fill(newEmail);
  await page.locator('[data-role="profile-current-password"]').fill('Not-The-Password-9!');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-role="profile-message"]')).toContainText(/password/i);

  const since = await mailMarker();
  await page.locator('[data-role="profile-current-password"]').fill(password);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-role="profile-message"]')).toContainText(/confirmation link/i);
  // The login email is unchanged until the link is confirmed.
  await expect(emailInput).toHaveValue(oldEmail);
  const before = await request.get(`${API_URL}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${oldBearer}` },
  });
  expect((await before.json()).user.email).toBe(oldEmail);

  // The confirmation goes to the new address, a notice to the old one.
  const confirmMail = await waitForMail({ to: newEmail, since });
  await waitForMail({ to: oldEmail, since, subject: /email|change/i });
  const link = extractLink(confirmMail.body, /^\/verify-email\/[^/]+$/);
  await page.goto(new URL(link).pathname);
  await expect(page.getByText('Email verified')).toBeVisible();

  // Old sessions are gone: the old bearer and the browser cookie both fail.
  const after = await request.get(`${API_URL}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${oldBearer}` },
  });
  expect(after.status()).toBe(401);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/(auth|login)/, { timeout: 10_000 });

  // Log in with the new email; the old one is no longer a login.
  const oldLogin = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: oldEmail, password },
  });
  expect(oldLogin.status()).toBe(401);
  await page.locator('input[name="email"]').fill(newEmail);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).not.toHaveURL(/\/(auth|login)/, { timeout: 15_000 });
  await page.goto('/settings');
  await expect(page.locator('[data-role="profile-email"]')).toHaveValue(newEmail);
});
