# Contributing to Pinpoint

This is the engineering standard. Everything in **Enforced** blocks a merge:
`main` is protected and requires every check below to pass on an up-to-date
branch. Everything in **Expected** is checked in review using the PR template.

## Workflow

1. Branch from `main`, open a pull request. Direct pushes to `main` and
   force-pushes are blocked for everyone, admins included.

`main` branch protection (applied 27 Nov 2026): pull request required; all 13
checks below required; branch must be up to date (`strict`); conversations
resolved; force-push and deletion blocked; enforced for admins. Required
approvals are **0** while there is a single maintainer (GitHub does not let an
author approve their own PR). **Raise it to 1** when a second maintainer joins:
Settings → Branches → `main` → *Require approvals*.
2. All required checks must be green, and the branch must be up to date with
   `main`.
3. Merge. A push to `main` publishes the Docker images to GHCR (`<sha>` and
   `latest`).

## Enforced (CI, required checks)

| Check | Workflow / job | Requirement |
|---|---|---|
| Typecheck + lint | `ci` / `lint-typecheck` | `tsc --build` 0 errors; ESLint 0 warnings in server and client code; `innerHTML`/`outerHTML`/`insertAdjacentHTML` banned in client code unless an allow-list comment explains why |
| Standards | `ci` / `standards` | `node scripts/check-standards.mjs`: exact dependency versions, actions pinned to commit SHAs, no `.only`/`fixme`/unexplained skips, **every mounted HTTP route has a test**; `npm audit --omit=dev` finds no vulnerabilities of moderate severity or higher |
| Unit + integration | `ci` / `test` | All tests pass against real Postgres + MinIO; coverage ≥ the ratchet in `vitest.config.ts` (only ever raised); demo-script tests on Node 22 |
| Browser e2e | `ci` / `e2e` | Playwright on Chromium, Firefox and WebKit (API, dashboard, user flows, real Chrome extension); a test that only passes on retry (**flaky**) fails the build |
| Shell scripts | `ci` / `shell-scripts` | `shellcheck` clean for `deploy/*.sh` and `infrastructure/scripts/*.sh` |
| Docker images | `ci` / `docker-build (server)`, `docker-build (dashboard)` | Both images build |
| Compose stacks | `compose-smoke (dev)`, `compose-smoke (prod)` | Dev and production stacks boot; HTTPS, strict preflight, `__Host-` cookies, RLS seeding, signed screenshot URLs |
| Install path | `install-e2e` | Fresh Ubuntu: `install.sh` ×2, app smoke, `backup.sh`, wipe + `restore.sh`, `upgrade.sh` |
| Other browsers | `firefox-e2e`, `firefox-package`, `safari-app` | Real Firefox harness 20/20; AMO package lints with 0 errors; Safari app builds and contains the extension |

Run the fast checks locally before pushing:

```bash
npx tsc --build tsconfig.json && npm run lint && node scripts/check-standards.mjs
DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=postgres DB_PASSWORD=unused DB_NAME=pinpoint_test npx vitest --run
```

## Expected (review, PR template)

- **Bug fixes come with a regression test** that fails without the fix.
- **New behaviour is tested at the right level**: unit for logic, integration
  (real Postgres) for data access and routes, Playwright for user-visible
  flows. Update `docs/TEST_MATRIX.md` when you add a route, page, worker or flow.
- **New tests pass twice** locally before review. Skips need a reason: use
  `describe.skipIf(cond)` / `test.skip(cond, 'reason')`, or a
  `// skip-reason:` comment on the line above an unconditional skip.
- **Security-relevant changes** (auth, access control, tenant isolation, input
  handling, outbound HTTP, secrets) get an entry in `docs/SECURITY_REVIEW.md`.
  Outbound HTTP goes through `safeFetch`; new tenant tables get RLS policies.
- **Dependencies**: exact versions only, well-known packages, and say why in
  the PR. Lockfile changes are reviewed.
- **Docs**: user-facing or operator-facing changes update README /
  `docs/DEPLOYMENT.md` / `docs/INTEGRATIONS_SETUP.md` as relevant.

## Exemptions

- A route the scanner cannot match textually goes into `ROUTE_EXEMPT` in
  `scripts/check-standards.mjs` with the test that covers it.
- Lowering a coverage threshold, adding an innerHTML allow-list entry, or
  skipping a required check needs a written justification in the PR.
