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
 *
 * Two kinds of project run here:
 *
 *   • `api`  — header-level API specs at the repo root (`*.spec.ts`). They
 *              use Playwright's request context against the API base URL and
 *              never open a browser.
 *   • `browser` (+ `browser-setup`) — real-UI specs under `browser/` that
 *              drive the live Dashboard (Vite dev on `FL_APP_URL`, which
 *              proxies `/api` to the API). A single `browser-setup` project
 *              performs ONE UI login (respecting the 5-logins/min auth rate
 *              limit) and saves `storageState` to `.auth/browser.json`; the
 *              `browser` project reuses it so individual specs never log in.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const API_BASE_URL = process.env.FL_API_URL ?? 'http://localhost:3001';
const APP_BASE_URL = process.env.FL_APP_URL ?? 'http://localhost:4173';

/** storageState written by `browser/auth.setup.ts` and reused by browser specs. */
export const BROWSER_STORAGE_STATE = '.auth/browser.json';

/**
 * Resolve an installed Chromium executable from the ms-playwright cache.
 *
 * The test runner (@playwright/test) and the locally installed browser
 * builds can drift (the runner may expect build 1223 while the cache holds
 * 1228). Rather than fail on that skew, we point `launchOptions.executablePath`
 * at whichever Chromium build is actually present — preferring the headless
 * shell, then the full "chrome-for-testing" build. An explicit
 * `PINPOINT_CHROMIUM_PATH` env var always wins.
 */
function resolveChromiumPath(): string | undefined {
  const explicit = process.env.PINPOINT_CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;

  let dirs: string[];
  try {
    dirs = readdirSync(cache);
  } catch {
    return undefined;
  }

  // macOS-arm64 candidate executables inside each matching build dir,
  // newest build number first.
  const shellDirs = dirs
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse();
  const fullDirs = dirs
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();

  const candidates: string[] = [
    ...shellDirs.map((d) =>
      join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    ),
    ...fullDirs.map((d) =>
      join(
        cache,
        d,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ),
    ),
  ];
  return candidates.find((c) => existsSync(c));
}

const CHROMIUM_PATH = resolveChromiumPath();
const chromiumLaunch = CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {};

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
  globalSetup: './global-setup.ts',
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
      // Header-level API specs at the repo root — never open a browser and
      // must NOT pick up the browser-UI specs under `browser/`.
      name: 'api',
      testDir: '.',
      testIgnore: /(browser|flows)\//,
      use: {
        baseURL: API_BASE_URL,
      },
    },
    {
      // One-time UI login that writes `.auth/browser.json`. Kept separate so
      // the real browser specs reuse a single session and never re-login
      // (the API rate-limits auth to 5 attempts/min per IP+email).
      name: 'browser-setup',
      testDir: './browser',
      testMatch: /.*\.setup\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: APP_BASE_URL,
        // Page navigations must not advertise `Accept: application/json`.
        extraHTTPHeaders: {},
        launchOptions: chromiumLaunch,
      },
    },
    {
      // Real-UI specs that drive the live Dashboard through a Chromium
      // browser. They reuse the setup project's storageState.
      name: 'browser',
      testDir: './browser',
      testMatch: /.*\.spec\.ts$/,
      // The extension spec launches its own persistent context (MV3 loading
      // needs `launchPersistentContext` + `--load-extension`), so it runs in
      // the dedicated `extension` project below, NOT here.
      testIgnore: /extension(-[\w-]+)?\.spec\.ts$/,
      dependencies: ['browser-setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: APP_BASE_URL,
        extraHTTPHeaders: {},
        storageState: BROWSER_STORAGE_STATE,
        launchOptions: chromiumLaunch,
      },
    },
    {
      // Multi-step user flows (`flows/*.spec.ts`): password reset, email
      // change, webhooks, … Each drives the real Dashboard and reads outbound
      // mail from the SMTP sink (`FL_MAIL_API` = Mailpit, else the dev
      // stack's mail.log). Reuses the setup project's storageState pattern.
      name: 'flows',
      testDir: './flows',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['browser-setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: APP_BASE_URL,
        extraHTTPHeaders: {},
        storageState: BROWSER_STORAGE_STATE,
        launchOptions: chromiumLaunch,
      },
    },
    {
      // Cross-engine coverage: the DASHBOARD browser specs on Firefox +
      // WebKit (Playwright's bundled builds). Extension specs need Chromium
      // (MV3) and the widget specs are owned/targeted separately, so both are
      // excluded. They reuse the Chromium setup project's cookie jar — the
      // cookies are plain localhost cookies.
      name: 'browser-firefox',
      testDir: './browser',
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /(extension[^/]*|widget[^/]*)\.spec\.ts$/,
      dependencies: ['browser-setup'],
      use: {
        ...devices['Desktop Firefox'],
        baseURL: APP_BASE_URL,
        extraHTTPHeaders: {},
        storageState: BROWSER_STORAGE_STATE,
      },
    },
    {
      name: 'browser-webkit',
      testDir: './browser',
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /(extension[^/]*|widget[^/]*)\.spec\.ts$/,
      dependencies: ['browser-setup'],
      use: {
        ...devices['Desktop Safari'],
        baseURL: APP_BASE_URL,
        extraHTTPHeaders: {},
        storageState: BROWSER_STORAGE_STATE,
      },
    },
    {
      // MV3 extension E2E. Loads `extension/dist/` into a persistent Chromium
      // context (the only config that runs an MV3 service worker). The spec
      // manages its own context/pages, so this project does NOT set
      // storageState or a Chromium executablePath — it relies on the
      // `channel: 'chromium'` launch inside the spec, which is the verified
      // path for loading unpacked MV3 extensions.
      name: 'extension',
      testDir: './browser',
      testMatch: /extension(-[\w-]+)?\.spec\.ts$/,
      use: {
        baseURL: API_BASE_URL,
        extraHTTPHeaders: {},
      },
    },
  ],
});
