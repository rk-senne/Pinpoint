/**
 * Stack-availability helpers.
 *
 * The E2E suite is designed to run in two modes:
 *
 *   1. CI / `docker compose up` — the API and Dashboard are reachable and
 *      every test runs end-to-end.
 *   2. Local dev with no live stack — the suite still loads, type-checks,
 *      and runs Playwright, but every spec calls `skipIfStackDown(test)`
 *      in `test.beforeAll` and skips when the API is unreachable. This
 *      keeps `npm test --workspace e2e` from failing on a developer
 *      machine that hasn't booted Postgres + the API yet (Task 22.1
 *      "confirm tests compile and skip gracefully when no live stack is
 *      running").
 *
 * The probe hits `GET /health`, which the API exposes unauthenticated and
 * returns `{status:"ok"}` for. A short timeout keeps the skip path snappy.
 */
import type { APIRequestContext, TestInfo } from '@playwright/test';

export const API_BASE_URL = process.env.FL_API_URL ?? 'http://localhost:3001';

let cached: boolean | null = null;

/**
 * Returns `true` when `GET <API_BASE_URL>/health` responds with 2xx within
 * a short timeout. Memoised across the run so multiple specs don't pay the
 * probe cost more than once.
 */
export async function isStackUp(request: APIRequestContext): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const res = await request.get(`${API_BASE_URL}/health`, { timeout: 2_000 });
    cached = res.ok();
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * Convenience wrapper: skips the current test when the stack is down with
 * a clear message so logs are easy to grep.
 */
export async function skipIfStackDown(
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<void> {
  const up = await isStackUp(request);
  if (!up) {
    testInfo.skip(
      true,
      `Pinpoint API not reachable at ${API_BASE_URL}. Run \`docker compose up\` to enable this suite.`,
    );
  }
}

/**
 * Generate a unique email for a test run so re-running the suite against
 * the same database doesn't trip the `users.email` UNIQUE constraint
 * (Requirement 1.1).
 */
export function uniqueEmail(prefix = 'e2e'): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}@example.test`;
}

/**
 * Default password that satisfies the policy in
 * `shared/src/passwordPolicy.ts` (≥10 chars per `PASSWORD_MIN_LENGTH`,
 * mixed case, digit, symbol).
 */
export const TEST_PASSWORD = 'P@ssw0rd-E2E-1!';
