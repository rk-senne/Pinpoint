/**
 * E2E shared-link lockout flow.
 *
 * Walks the lockout state machine documented in design.md decision #9
 * and `server/src/services/sharedLinks.ts`:
 *
 *   - Owner creates a shared link with a password.
 *   - Three wrong-password attempts in a row produce HTTP 401 each, with
 *     `attemptsRemaining` ticking down: 2, 1, 0.
 *   - The third attempt also locks the link, so the *next* call (even
 *     with the correct password) returns 423 Locked with a `Retry-After`
 *     header.
 *
 * Requirements covered:
 *   - 15.3 — three failures lock the link
 *   - 15.4 — locked attempts return 423 + `Retry-After`
 *   - 18.1, 18.4 — cookie + CSRF for the link-creation step
 *
 * The 15-minute "lock expires → success" leg of the FSM is exercised by
 * the property-based test in
 * `server/src/__tests__/properties/sharedLinkLockout.property.test.ts`
 * using a mocked clock; advancing the wall clock 15 minutes inside an
 * E2E run is impractical, so this spec focuses on the lockout entry
 * transition.
 */
import { expect, test } from '@playwright/test';

import { loginExisting } from './helpers/auth.js';
import { withTemporaryProject } from './helpers/projects.js';
import {
  API_BASE_URL,
  skipIfStackDown,
} from './helpers/stack.js';

test.describe('shared link lockout', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('three wrong attempts lock the link with 423 + Retry-After', async ({
    request,
  }) => {
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    // 1. Create a fresh project to attach the shared link to. The helper
    //    handles the matching DELETE in its `finally` block, so any
    //    failure inside the try below still cleans up the project.
    const projectName = `e2e-shared-${Date.now()}`;
    await withTemporaryProject(
      request,
      session,
      { name: projectName, urls: ['https://example.com/shared'] },
      async (project) => {
        // 2. Create a password-protected shared link.
        const password = `correct-horse-${Date.now()}`;
        const shareRes = await request.post(
          `${API_BASE_URL}/api/v1/projects/${project.id}/share`,
          {
            headers: session.mutatingHeaders(),
            data: { password },
          },
        );
        expect([200, 201]).toContain(shareRes.status());
        const { sharedLink } = await shareRes.json();
        expect(sharedLink?.id).toBeTruthy();
        expect(sharedLink.hasPassword).toBe(true);

        // 3. Three wrong-password attempts. The verify endpoint is
        //    unauthenticated and CSRF-exempt, so no headers are needed.
        const verifyUrl = `${API_BASE_URL}/api/v1/shared/${sharedLink.id}/verify`;
        const expectedRemaining = [2, 1, 0];
        for (const remaining of expectedRemaining) {
          const wrong = await request.post(verifyUrl, {
            data: { password: 'definitely-wrong' },
          });
          expect(wrong.status()).toBe(401);
          const body = await wrong.json();
          expect(body.error?.code).toBe('INVALID_PASSWORD');
          expect(body.error?.details?.attemptsRemaining).toBe(remaining);
        }

        // 4. The next attempt — even with the correct password — must
        //    be locked with 423 + Retry-After (Req 15.4).
        const lockedRes = await request.post(verifyUrl, {
          data: { password },
        });
        expect(lockedRes.status()).toBe(423);
        const retryAfter = lockedRes.headers()['retry-after'];
        expect(retryAfter).toBeTruthy();
        // Retry-After should be a positive integer (seconds) ≤ 15 minutes.
        const seconds = Number.parseInt(String(retryAfter), 10);
        expect(seconds).toBeGreaterThan(0);
        expect(seconds).toBeLessThanOrEqual(15 * 60);

        const lockedBody = await lockedRes.json();
        expect(lockedBody.error?.code).toBe('LOCKED');
      },
    );
  });
});
