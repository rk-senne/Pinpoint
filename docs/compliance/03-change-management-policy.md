# 03 — Change Management Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<engineering lead>` | `<security owner>` | Annual | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. Scope
Application code, database migrations, infrastructure/deploy configuration (`deploy/`, `docker-compose*.yml`,
`Caddyfile`), CI workflows, and the browser extension releases.

## 2. Standard change (everything normal)
1. **Branch + pull request** against `main`. Direct pushes to `main` are prohibited. *(Enforce with GitHub branch protection — see §5; not visible in the repo.)*
2. **Review:** at least one approving review by someone other than the author (two for auth, tenant isolation, migrations, deploy config, CI workflows — see CODEOWNERS `<to be created>`).
3. **Automated gates (must be green to merge)** — the actual jobs in `.github/workflows/ci.yml`:
   - `lint-typecheck`: `npm run typecheck`, `npm run lint` (includes server hexagonal-boundary rules).
   - `test`: full Vitest suite with coverage against a real PostgreSQL 16 and an S3-compatible service (MinIO); runs migrations; includes the RLS integration tests (`rls.test.ts`) as the `pinpoint_app` role.
   - `e2e`: Playwright against a real stack — API, dashboard on Chromium/Firefox/WebKit, MV3 extension — with the API as `pinpoint_app`.
   - `docker-build` (PRs): both images build (no push).
   - `shell-scripts`: `bash -n` + `shellcheck` over `deploy/*.sh` and `infrastructure/scripts/*.sh`.
   - `compose-smoke` (`.github/workflows/compose-smoke.yml`): boots the dev and prod Compose stacks when Docker/deploy/server/dashboard files change.
4. **Merge** only by squash/merge after approvals. Link the ticket/issue or finding ID (e.g. `PP-xx`) in the PR.
5. **Publish:** pushing to `main` runs `docker-publish` (only job with `packages: write`) after `lint-typecheck`, `test`, `e2e` pass; images are tagged `<git-sha>` and `latest`.
6. **Deploy** is a deliberate, manual step on the host: `deploy/upgrade.sh` (takes a backup, pulls, migrates, restarts). Production uses the **`<git-sha>` image tag**, not `latest` (`PINPOINT_SERVER_IMAGE`/`PINPOINT_DASHBOARD_IMAGE`). Deployer ≠ author where team size allows; otherwise the PR approver is recorded.
7. **Post-deploy check:** `curl -f https://<domain>/health`, widget served, `/metrics` not public (`docs/DEPLOYMENT.md §6`).

## 3. Database migrations
Forward-only in production. Anything with a migration needs a backup first (`upgrade.sh` does this) and a stated rollback
(restore the backup). Migrations run as the schema owner; the API runs as `pinpoint_app`.

## 4. Emergency change
Allowed for an active security incident or outage: Security owner/Engineering lead approves verbally, change is made via a
PR as soon as possible (can be merged with post-hoc review within 1 working day), and a note is added to the incident
record ([04](04-incident-response-plan.md)).

## 5. Required repository settings (verify in GitHub — cannot be checked from the repo)
- Branch protection on `main`: require PR, ≥ 1 approval, dismiss stale approvals, require the CI status checks above, no force-push, no deletion, include administrators.
- `.github/CODEOWNERS` for `server/src/migrations/`, `deploy/`, `.github/workflows/`, `server/src/config.ts`.
- Third-party Actions pinned to full commit SHAs (already the practice; bump deliberately).
- CI uses only the short-lived `GITHUB_TOKEN`; no long-lived cloud keys in Actions secrets.
- Record a screenshot of the settings quarterly as evidence ([02 §4](02-access-control-policy.md)).

## 6. Browser-extension releases
Follow the README "Release Process" (SemVer, `CHANGELOG.md`, build, store upload, git tag) and `docs/STORE_SUBMISSION.md`.
Permission changes are a MAJOR version and need Security owner approval.

## 7. Records
PRs, CI runs, review approvals, release tags and `docker-publish` runs are the change records; retain ≥ 12 months.

## 8. Sign-off
Approved by `<name>` on `<date>`.
