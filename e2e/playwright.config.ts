/**
 * Playwright configuration for the Pinpoint end-to-end suite.
 *
 * Per design.md §"End-to-End Tests" and Requirement 30, Playwright drives
 * E2E only — Vitest covers unit + property + integration. The default
 * baseURL points at the dev stack defined in `docker-compose.yml`
 * (`http://localhost:3001` for the API, `http://localhost:4173` for the
 * Dashboard); both are overridable via env vars so the same suite can run
 * against staging.
 *
 * The tests are written to skip gracefully when no live stack is reachable
 * (see `helpers/stack.ts`). That keeps `npm test --workspace e2e` runnable
 * on a developer machine that hasn't started Postgres + the API yet, while
 * still exercising the full stack in CI when the services are up.
 */
import { defineConfig } from '@playwright/test';

const API_BASE_URL = process.env.FL_API_URL ?? 'http://localhost:3001';
const APP_BASE_URL = process.env.FL_APP_URL ?? 'http://localhost:4173';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // Run sequentially to keep the test database in a predictable state when
  // multiple specs hit `/api/v1/auth/register` with similar fixture data.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: APP_BASE_URL,
    extraHTTPHeaders: {
      Accept: 'application/json',
    },
    // Persist cookies between requests within a single test so the
    // `fl_session` cookie issued by `POST /api/v1/auth/login` automatically
    // travels on subsequent calls (Req 18.1, design key decision #4).
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'api',
      use: {
        baseURL: API_BASE_URL,
      },
    },
  ],
});
