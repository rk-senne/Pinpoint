# 11 — Risk Assessment Template and Initial Risk Register

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner>` | `<management>` | Full assessment annually; register reviewed quarterly and on major change/incident | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim. The ratings below are **initial internal
estimates** seeded from `docs/SECURITY_REVIEW.md` (internal review, not an independent pen test); the owner must
re-rate them.

## 1. Method
1. List assets (customer data, service availability, secrets, source code, reputation) and threats.
2. Score **Likelihood** (1 rare – 5 almost certain) × **Impact** (1 minor – 5 severe) = **Score** (1–25): ≥ 15 High, 8–14 Medium, ≤ 7 Low.
3. Choose treatment: **Mitigate** (control + owner + date), **Accept** (management sign-off), **Transfer** (insurance/vendor), **Avoid**.
4. Consider fraud/insider risk and risk from changes (new vendor, feature, hosting move).
5. Record residual risk after existing controls. Re-rate when a control ships.

## 2. Register entry template
`ID | Risk | Asset | Existing controls | L | I | Score | Treatment | Owner | Due | Status | Source`

## 3. Initial register (from SECURITY_REVIEW residual items and readiness gaps)

| ID | Risk | Existing controls | L | I | Score | Treatment / next step | Owner | Source |
|---|---|---|---|---|---|---|---|---|
| R-01 | Cross-tenant data exposure through a new bug or a `systemScope` route relying on its own `org_id` predicates | App `org_id` scoping + enforced RLS (`pinpoint_app`, fail-closed) + 11 RLS tests + IDOR matrix; a superuser DB owner bypasses RLS | 2 | 5 | 10 M | Mitigate: keep RLS test per new table; never run API as owner; external pen test | `<>` | PP-08 |
| R-02 | Supply-chain compromise (npm deps, base images, GHCR images unscanned) | Pinned action SHAs, lockfile, tests | 3 | 4 | 12 M | Mitigate: Dependabot, `npm audit` gate, CodeQL, Trivy, SBOM (08 §3) | `<>` | SOC2 CC7.1 |
| R-03 | Undiscovered vulnerabilities — no independent penetration test | Internal adversarial review, regression tests | 3 | 4 | 12 M | Mitigate: commission pen test before first enterprise customer | `<>` | SEC_REVIEW §6 |
| R-04 | Account takeover — no MFA/SSO for customers; staff MFA is process-only | bcrypt, rate limits, session revocation, absolute session cap, CSRF binding | 3 | 4 | 12 M | Mitigate: TOTP/WebAuthn for owners/admins, enforce staff MFA now | `<>` | SOC2 CC6.1 |
| R-05 | Single-VM availability loss (host/provider outage) | `restart: unless-stopped`, healthchecks, backups, reproducible `install.sh` | 3 | 3 | 9 M | Accept with RTO 4 h target; revisit at first SLA | `<>` | A1.2 |
| R-06 | Backups untested or only on the same host → unrecoverable data loss | `backup.sh`, retention, `upgrade.sh` pre-backup | 3 | 5 | 15 H | Mitigate: off-box encrypted copy + first restore test (05 §4) | `<>` | A1.3 |
| R-07 | Integrations (Slack, Jira, Linear, GitHub, ClickUp, Asana) tested only against fake providers → data sent wrongly or failure in production | Egress guard, encrypted tokens | 3 | 2 | 6 L | Mitigate: one real connect + Send-to per provider before enabling | `<>` | INTEGRATIONS_SETUP |
| R-08 | Sensitive content in screenshots/replays; uploads validated by PNG signature only (no re-encode/malware scan) | Signed 15-min screenshot URLs, private storage, masked sensitive fields, `nosniff` | 2 | 3 | 6 L | Mitigate: re-encode with a decoder; retention cap | `<>` | PP-18 |
| R-09 | Audit-log evidence can be disabled by a DB superuser; some mutations unaudited (429 logins, boards update/delete, workflow/SLA) | Append-only trigger, ip/UA/request id | 2 | 3 | 6 L | Mitigate: ship to off-host store ≥ 12 months; extend coverage | `<>` | PP-22 |
| R-10 | No org/user deletion workflow; screenshot files may outlive deleted annotations | FK cascades, manual DB deletion | 3 | 3 | 9 M | Mitigate: implement delete-org job incl. storage cleanup; reconcile files | `<>` | PP-10 |
| R-11 | Weak-but-unlisted passwords (no breached-password check; unverified accounts not purged) | Length ≥ 10, blocklist/stem rules, distinct chars | 3 | 2 | 6 L | Mitigate: HIBP k-anonymity check, purge job | `<>` | PP-12 |
| R-12 | Public board votes use self-declared e-mail; NAT users share an IP-hash vote | Per-board/IP quotas, IP-hash dedupe | 3 | 1 | 3 L | Accept | `<>` | PP-20 |
| R-13 | Team invite adds same-org users without consent | Org-scoped teams, viewer default | 2 | 2 | 4 L | Accept until product decision | `<>` | PP-04 |
| R-14 | Loss/rotation of `INTEGRATION_ENCRYPTION_KEY` makes stored tokens/webhook secrets unreadable; leak exposes them | Key only in env file, separate secret copy (05) | 2 | 4 | 8 M | Mitigate: documented rotation procedure and re-encryption script | `<>` | DEPLOYMENT §4 |
| R-15 | Extension reach: Safari build untested in Safari; store-review rejection; permission-change friction | Firefox 161/ESR 140/128 harness 20/20, Chrome e2e | 3 | 2 | 6 L | Mitigate: manual Safari test before submission | `<>` | STORE_SUBMISSION |
| R-16 | MCP/AI agent prompt injection from public feedback text | Untrusted-content envelope, scoped keys, https-only | 2 | 3 | 6 L | Mitigate: default read-only keys for triage agents | `<>` | PP-16 |
| R-17 | Known moderate, dev-only dependency advisories (3) | Not in runtime image | 2 | 1 | 2 L | Accept; review at each `npm audit` | `<>` | Crash course §5 |
| R-18 | Key-person dependency / small team (no separation of duties) | ADRs, runbooks, docs | 4 | 3 | 12 M | Mitigate: second reviewer, shared break-glass, documented runbooks | `<>` | CC1 |
| R-19 | SMTP vendor/DNS compromise or misconfiguration (phishing from our domain, lost verification mail) | SPF/DKIM/DMARC (to set), durable queue with retry, escaped templates | 2 | 3 | 6 L | Mitigate: DMARC p=quarantine/reject, registrar MFA + lock | `<>` | GO_LIVE_PLAN |
| R-20 | Host logs/Docker logs not retained (evidence gap and slower forensics) | pino logs on host | 4 | 2 | 8 M | Mitigate: log rotation + off-host shipping (09) | `<>` | CC7.2 |

## 4. Assessment record (fill annually)
Date · participants · scope · new risks identified · risks re-rated · treatments approved · approver signature.

## 5. Sign-off
Approved by `<name>` on `<date>`.
