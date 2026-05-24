/**
 * E2E auth flow — register → unverified-login is rejected → existing
 * verified account logs in successfully and CSRF is enforced.
 *
 * Requirements covered:
 *   - 1.1   — registration creates an account
 *   - 18.1  — login issues `fl_session` cookie (HttpOnly, SameSite=Lax)
 *   - 18.3  — login issues `fl_csrf` cookie + body `csrfToken`
 *   - 18.4  — `POST` / `PUT` / `PATCH` / `DELETE` requires `X-CSRF-Token`
 *   - 18.5  — missing/mismatched CSRF returns 403
 *   - 20.4  — login is blocked until email is verified
 *
 * Skips when the API is not reachable (Task 22.1 — "tests compile and
 * skip gracefully when no live stack is running").
 */
import { expect, request as requestFactory, test } from '@playwright/test';

import { loginExisting, register } from './helpers/auth.js';
import { withTemporaryProject } from './helpers/projects.js';
import {
  API_BASE_URL,
  TEST_PASSWORD,
  skipIfStackDown,
  uniqueEmail,
} from './helpers/stack.js';

test.describe('auth (cookie + CSRF)', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
  });

  test('register creates user and login is blocked until verified', async ({
    request,
  }) => {
    const email = uniqueEmail('auth');
    const registerRes = await register(request, email, TEST_PASSWORD, 'E2E User');
    expect(registerRes.status()).toBe(201);

    const body = await registerRes.json();
    expect(body.user.email).toBe(email.toLowerCase());

    // Login MUST fail with EMAIL_NOT_VERIFIED until the user redeems the
    // verification token (Req 20.4).
    const loginRes = await request.post(`${API_BASE_URL}/api/v1/auth/login`, {
      data: { email, password: TEST_PASSWORD },
    });
    expect(loginRes.status()).toBe(401);
    const loginBody = await loginRes.json();
    expect(loginBody.error?.code).toBe('EMAIL_NOT_VERIFIED');
  });

  test('seeded verified account can log in and exercise CSRF', async ({ request }) => {
    const seedEmail = process.env.FL_E2E_EMAIL;
    const seedPassword = process.env.FL_E2E_PASSWORD;
    test.skip(
      !seedEmail || !seedPassword,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this test.',
    );

    const { session, user } = await loginExisting(request, seedEmail!, seedPassword!);
    expect(user.email).toBe(seedEmail!.toLowerCase());

    // GET /users/me — read-only, no CSRF header required.
    const meRes = await request.get(`${API_BASE_URL}/api/v1/users/me`);
    expect(meRes.ok()).toBe(true);

    // Mutating request WITHOUT the CSRF header MUST be rejected (Req 18.5).
    const noCsrfReq = await requestFactory.newContext();
    // Replay the login first to get the cookies into the new context.
    await noCsrfReq.post(`${API_BASE_URL}/api/v1/auth/login`, {
      data: { email: seedEmail, password: seedPassword },
    });
    const blocked = await noCsrfReq.post(`${API_BASE_URL}/api/v1/projects`, {
      data: { name: 'no-csrf', urls: ['https://example.com'] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(blocked.status()).toBe(403);
    await noCsrfReq.dispose();

    // Mutating request WITH the CSRF header succeeds. Wrap the create in
    // `withTemporaryProject` so the project is always cleaned up — even
    // if a later assertion fails — without sprinkling delete calls
    // around the spec.
    await withTemporaryProject(
      request,
      session,
      { name: `auth-spec-${Date.now()}`, urls: ['https://example.com/'] },
      async (project) => {
        expect(project.id).toBeTruthy();
      },
    );
  });
});
