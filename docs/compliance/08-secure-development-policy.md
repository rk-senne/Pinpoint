# 08 — Secure Development Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<engineering lead>` | `<security owner>` | Annual | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. Design and coding rules (already the project's conventions — keep them)
1. **Tenant isolation by default:** every query scoped by `org_id`; new tenant tables get an RLS policy in the migration and a case in `server/src/__tests__/integration/rls.test.ts`. Public/pre-tenant routes must opt in to `systemScope` deliberately and keep their own `org_id` predicates.
2. **Validate all input** with Zod, with `.max()` bounds on every string; errors use the `{error:{code,message,details}}` envelope; never return stack traces outside development.
3. **Outbound HTTP only via `safeFetch`** (SSRF guard: https only, DNS-pinned, private ranges blocked, timeout, size cap).
4. **No `innerHTML` with dynamic data** — the dashboard uses `el`/`setText`; extension templates interpolate only static strings. User text goes through `textContent`.
5. **Secrets:** never in code/logs/commits; integration tokens and webhook secrets encrypted via `SecretBox`; logs redact secrets.
6. **AuthZ at the route layer:** viewer-write guard applies to every tenant router; new mutating routes are covered by the table-driven `viewerWriteGuard.test.ts`.
7. **Dependencies:** avoid new dependencies; if needed, use an exact version from a well-known maintained package and justify it in the PR. Third-party Actions pinned to commit SHAs.
8. **Least-privilege runtime:** API image runs as non-root; the API connects to Postgres as `pinpoint_app` (NOSUPERUSER NOBYPASSRLS).

## 2. Security in the workflow
- Threat-think in the PR description for anything touching auth, sessions, tenant boundaries, file upload, URL fetching, webhooks, integrations, or the extension's permissions.
- Security-relevant PRs need a second reviewer ([03](03-change-management-policy.md)).
- Findings use stable IDs (`PP-nn` in `docs/SECURITY_REVIEW.md`) with a regression test per fix.

## 3. Automated checks
Today (in CI): typecheck, ESLint (hexagonal boundaries), unit/integration tests on real PostgreSQL, Playwright e2e, Docker build, shellcheck.
**Gaps to close** (SOC2_READINESS CC7.1): add `npm audit --omit=dev` as a gate, Dependabot/Renovate, CodeQL, gitleaks secret scanning, a container scan (Trivy) of the GHCR images, SBOM generation. Until they exist, run `npm audit --omit=dev` before each release and record the result.

## 4. Vulnerability handling
- Intake: `SECURITY.md` + `security@<domain>` (to be published); acknowledge within 2 working days.
- Remediation targets: **Critical 7 days, High 30 days, Medium 90 days**, tracked in the risk register ([11](11-risk-assessment-and-register.md)); exceptions need Security owner approval.
- Independent testing: external penetration test annually and after major architectural change; `docs/SECURITY_REVIEW.md` is an internal review and is not a substitute.

## 5. Test data and environments
Development and CI use throwaway data only. Never copy production dumps to laptops; if needed for debugging, restore on a scratch VM, scrub/delete afterwards.

## 6. Releases
Follow [03](03-change-management-policy.md). Extension permission changes are a MAJOR release with Security owner approval; store listings' privacy disclosures must match what the extension actually sends (`docs/STORE_SUBMISSION.md §1.4`).

## 7. Sign-off
Approved by `<name>` on `<date>`.
