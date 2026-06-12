/**
 * E2E billing endpoint smoke test.
 *
 * These are smoke tests that verify billing endpoints respond without
 * crashing. The actual Stripe integration is not configured in dev, so
 * we accept 200 (configured) or 404 (not implemented yet) as valid.
 *
 * Skips when the API is not reachable (Task 22.1).
 */
import { expect, test } from '@playwright/test';

import { loginExisting } from './helpers/auth.js';
import { API_BASE_URL, skipIfStackDown } from './helpers/stack.js';

test.describe('billing (smoke)', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('GET /billing/usage returns usage data or 404', async ({ request }) => {
    await loginExisting(request, process.env.FL_E2E_EMAIL!, process.env.FL_E2E_PASSWORD!);

    const res = await request.get(`${API_BASE_URL}/api/v1/billing/usage`);
    // 200 = billing configured, 404 = not implemented yet — both acceptable
    expect([200, 404]).toContain(res.status());

    if (res.ok()) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });

  test('GET /billing/subscription returns status or 404', async ({ request }) => {
    await loginExisting(request, process.env.FL_E2E_EMAIL!, process.env.FL_E2E_PASSWORD!);

    const res = await request.get(`${API_BASE_URL}/api/v1/billing/subscription`);
    expect([200, 404]).toContain(res.status());

    if (res.ok()) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });
});
