# Pinpoint E2E Suite

End-to-end Playwright tests that exercise the Pinpoint API as a real
client would: cookie+CSRF auth for the dashboard flows (Req 18), the
multi-URL project + page model (Req 23), CSV export with browser/OS
columns (Req 11), and the shared-link lockout state machine (Req 15).

> Per design.md §"End-to-End Tests" and Requirement 30, **Playwright
> drives E2E only** — Vitest covers unit, property, and integration tests
> across `shared/`, `server/`, `dashboard/`, and `extension/`.


## Running against a real stack

The suite has three Playwright projects:

| Project | What it drives | Needs |
|---|---|---|
| `api` | REST API contracts (`*.spec.ts`) | API |
| `browser` | The real dashboard UI in Chromium (`browser/*.spec.ts`) | API + dashboard (`FL_APP_URL`) |
| `extension` | The built MV3 extension loaded into Chromium (`browser/extension.spec.ts`) | API + `npm run build --workspace extension` |

One-time setup for a local or CI stack:

```bash
# 1. API with a raised per-IP ceiling (one machine runs the whole suite)
API_RATE_LIMIT_MAX=5000 npm start --workspace server
# 2. Seed a verified account (see "Seeding the account" below), then run:
FL_API_URL=http://127.0.0.1:3001 FL_APP_URL=http://localhost:5173 \
FL_E2E_EMAIL=e2e-seed@example.test FL_E2E_PASSWORD='P@ssw0rd-E2E-1!' \
  npm test --workspace e2e
```

### Seeding the account

The repo does not ship a seeding script. Create the account through the
normal flow: `POST /api/v1/auth/register`, verify the email (the link is in
Mailpit at http://localhost:8025 on the Compose stack, or call
`POST /api/v1/auth/verify-email/:token`), then log in once — the first login
of a verified user provisions their personal org. The free plan caps projects
at 2, so set that org's `organizations.plan` to `pro` in the database before a
full run. Use the same email/password for `FL_E2E_EMAIL` / `FL_E2E_PASSWORD`.

`global-setup.ts` logs the seed account in once per run (the API allows
5 auth attempts per minute per IP+email) and shares that session with every
spec. Extensions only load in Playwright's bundled Chromium (`channel:
'chromium'`); branded Chrome 137+ ignores `--load-extension`. Set
`PINPOINT_CHROMIUM_PATH` to force a specific Chromium executable for the
`browser` project.

## Prerequisites

1. The full stack is up:
   ```bash
   docker compose up
   ```
   The API must be reachable at `http://localhost:3001` (override with
   `FL_API_URL`) and the Dashboard at `http://localhost:4173` (override
   with `FL_APP_URL`).
2. A verified seed account exists in the database. Most specs exercise
   authenticated flows and pull credentials from the environment:
   ```bash
   export FL_E2E_EMAIL=seed@example.com
   export FL_E2E_PASSWORD='your-seed-password'
   # Optional — needed by the export-columns assertion in projects.spec.ts
   export FL_E2E_PROJECT_ID=<uuid of a project that has at least one annotation>
   ```
   Specs that need the seed call `test.skip(...)` when it isn't set, so
   running the suite without seed values still produces a clean pass.
3. Install Playwright the first time:
   ```bash
   npm install --workspace e2e
   ```
   The CI workflow installs and caches Playwright browsers automatically;
   the `api` project needs no browser binary, while `browser` and
   `extension` need Chromium (`npx playwright install chromium`).

## Run

From the repository root:

```bash
npm run test --workspace e2e
```

Or directly inside `e2e/`:

```bash
npx playwright test
```

When the API is unreachable, every spec calls `skipIfStackDown(...)` in
`test.beforeEach` and the run reports `skipped` rather than failing —
this matches Task 22.1's "tests compile and skip gracefully when no live
stack is running" requirement.

## What's covered

| Spec | Project | Notes |
|---|---|---|
| `auth.spec.ts` | api | register → unverified login is rejected; seeded verified account passes the cookie+CSRF gauntlet (Req 1.1, 18.x, 20.4) |
| `projects.spec.ts` | api | multi-URL project creates one Page row per URL; CSV export emits the browser/OS columns (Req 23.1, 11.3, 11.4) |
| `sharedLinkLockout.spec.ts` | api | three wrong attempts → 423 + `Retry-After` (Req 15.3, 15.4) |
| `annotations.spec.ts`, `teams.spec.ts`, `notifications.spec.ts`, `webhooks.spec.ts`, `billing.spec.ts` | api | REST contracts for those areas |
| `browser/dashboard.spec.ts`, `onboarding.spec.ts`, `sendto.spec.ts`, `review.spec.ts`, `widget.spec.ts` | browser | real dashboard UI in Chromium (review-link frame, widget, Send-to menu, onboarding) |
| `browser/extension.spec.ts` | extension | loads the built `extension/dist/` (MV3) into Chromium and signs in with the seed account |

The 15-minute "lock expires → success" leg of the lockout FSM is covered
by the property-based test in
`server/src/__tests__/properties/sharedLinkLockout.property.test.ts`,
which uses a mocked clock instead of advancing wall time.

## Auth flow used by the helpers

`helpers/auth.ts#loginExisting` mirrors the production dashboard:

1. `POST /api/v1/auth/login` with the seed credentials. The server
   returns `{ user, csrfToken, token }` and sets two cookies:
   `fl_session` (HttpOnly, SameSite=Lax) and `fl_csrf` (readable).
2. The CSRF token from the response body is captured into the returned
   `AuthSession.csrfToken`. **No `localStorage` is touched.**
3. `session.mutatingHeaders()` produces
   `{'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}` —
   tests attach this to every `POST` / `PUT` / `PATCH` / `DELETE`. Read
   requests skip the header (the CSRF middleware doesn't enforce it on
   `GET`).
4. Playwright's `APIRequestContext` keeps both cookies in its jar, so
   subsequent calls automatically send `Cookie: fl_session=...; fl_csrf=...`.
   The `request.use({ ... })` block in `playwright.config.ts` intentionally
   does NOT pass an `Authorization: Bearer ...` header — the dashboard
   path of the API authenticates by cookie only (Req 18.1).

## Adding new specs

* Drop a `*.spec.ts` next to the existing files; Playwright's
  `testMatch` regex picks them up automatically.
* Always start with `await skipIfStackDown(request, testInfo)` so the
  spec is no-op when the API is down.
* For mutating calls, use `session.mutatingHeaders()` rather than
  hand-rolling `X-CSRF-Token` so the requirement link stays explicit
  in code review.
* Clean up after yourself — delete projects, etc. — so the suite is
  re-runnable against the same database.
