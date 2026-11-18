# Pinpoint — SOC 2 Readiness Gap Assessment

**Status: gap assessment only. Pinpoint is NOT SOC 2 compliant, has not been audited, and nothing here is an
attestation or a claim of compliance.** SOC 2 is an attestation by an independent CPA firm over an *organization*
(people, policies, operations), not a property of source code. A repository can only evidence the technical subset of
controls. This document maps what exists in the repo to the AICPA Trust Services Criteria (TSC 2017, 2022 points of
focus) and lists what is missing.

- Date: 2026-11-16 · Basis: repository state on `feat/enhancement-roadmap` + `docs/SECURITY_REVIEW.md`
  (internal review, not an external pentest).
- Scope assumed: Security (Common Criteria CC1–CC9) mainly; Availability (A1) and Confidentiality (C1) briefly.
  Processing Integrity and Privacy are out of scope here (note: the product stores end-user e-mail addresses, session
  replays, console/network captures and screenshots → Privacy/GDPR work is a separate track).
- Rating key: **Partial** = technical control exists but is incomplete or unevidenced; **Gap** = nothing in repo;
  **Org** = needs a process/policy that cannot live in code.

## 1. Summary

| Area | Technical controls in repo | Biggest gaps |
|---|---|---|
| Access control (CC6.1–6.3) | Strong app-level RBAC, tenant isolation, session revocation, hashed secrets | Viewer role gaps (PP-05), realtime leaks (PP-01/02), no MFA/SSO, no access reviews, no admin-access to prod procedure |
| Monitoring / logging (CC7.1–7.3) | `pino` JSON logs w/ redaction, request ids, Prometheus metrics, Prometheus alerting rules (to be defined), app audit log | Audit log is narrow (PP-22), 30-day log retention, no SIEM / host audit-log shipping, no alert-on-security-event, no incident-response plan |
| Change management (CC8.1) | CI (lint, typecheck, tests, e2e), pinned action SHAs, GitHub `environment: production` on deploy | No evidence of mandatory PR review / branch protection, no SAST/SCA/secret scanning/SBOM, no change tickets |
| Risk & vendor mgmt (CC3, CC9) | None | No risk register, no vendor inventory/assessments (hosting provider, Stripe, SMTP, GitHub, npm supply chain) |
| Availability (A1) | `pg_dump` backup procedure (`docs/DEPLOYMENT.md §4`), health/ready probes, graceful shutdown, `restart: unless-stopped` | No tested restore / DR runbook, no RPO/RTO, single region, no status page, no capacity plan |
| Confidentiality (C1) | TLS 1.2/1.3 at the Caddy edge, disk/volume encryption at rest (host/provider responsibility), secrets in a root-only `deploy/.env.production`, encrypted integration tokens | No data classification, retention/deletion process (PP-10), webhook secrets plaintext (PP-11), screenshots on public object-store/CDN URLs |
| Governance (CC1–CC2, CC5) | ADRs, CONTRIBUTING, README/DEPLOYMENT docs | No security policies, no onboarding/offboarding, training, background checks, board/management oversight |

Realistic effort: **6–9 months** to a Type I report and a further 3–12 months of operating evidence for Type II,
dominated by organizational work, not code.

## 2. Control mapping by Trust Services Criteria

### CC1 — Control environment · CC2 — Communication · CC3 — Risk assessment · CC4 — Monitoring of controls

| Criterion | Existing (evidence) | Gap | Type |
|---|---|---|---|
| CC1.1–1.5 integrity, oversight, structure, competence, accountability | `CONTRIBUTING.md`, ADRs `docs/adr/001-006` (design rationale only) | Code of conduct, org chart, defined security owner, management/board oversight, hiring/background checks, security training, disciplinary process | Org |
| CC2.1–2.3 information & communication | `README.md`, `docs/DEPLOYMENT.md`, `docs/HOW_TO_RUN.md` | Internal security-policy set, external system description (service commitments, SLAs), customer-facing security/trust page, vulnerability disclosure policy (`SECURITY.md` missing), incident communication process | Org |
| CC3.1–3.4 risk assessment | `docs/SECURITY_REVIEW.md` (this review) is a one-off technical risk input | Risk register, annual risk assessment, fraud-risk consideration, change-driven reassessment | Org |
| CC4.1–4.2 monitoring of controls | CI tests (`.github/workflows/ci.yml`) continuously check some controls | Periodic control self-assessment, internal audit, tracking/closure of findings (use `SECURITY_REVIEW.md` IDs as the first tickets) | Org |

### CC5 — Control activities

| Criterion | Existing | Gap |
|---|---|---|
| CC5.1–5.3 | Hexagonal architecture + ESLint boundary rules enforce layering (`npm run lint`); ADRs | Written policies and procedures mapped to controls; control owners; policy review cadence — **Org** |

### CC6 — Logical and physical access

| Criterion | Existing technical controls (file) | Gaps |
|---|---|---|
| **CC6.1** logical access software, infrastructure, architectures | Authn via bcrypt (`domain/auth/usecases/login.ts`), JWT HS256 + `token_version` revocation and live membership check (`adapters/inbound/http/auth.middleware.ts`), HttpOnly cookie + double-submit CSRF (`middleware/csrf.ts`), org/project access predicate (`adapters/inbound/http/access.ts`), RBAC (`requireRole`, `requireOrgAdmin`, `requireWriteAccess`), API-key scopes + route allow-list (`middleware/apiKeyOrJwt.ts`), widget key origin binding (`middleware/widgetCors.ts`, `widget.routes.ts`), SSRF egress guard (`services/egressGuard.ts`), secrets supplied via `deploy/.env.production` (mode 600, never in git), integration tokens AES-GCM (`INTEGRATION_ENCRYPTION_KEY`), boot preflight refusing dev secrets (`server/src/config.ts`) | **No MFA/TOTP/SSO (SAML/OIDC)** for customers or staff; weak password policy (PP-12); viewer RBAC incomplete (PP-05); RLS present but inert (PP-08); DB app role is superuser in the dev stack — prod role not codified; webhook secrets plaintext (PP-11); no WAF in front of Caddy; no session inventory / device list; no absolute session lifetime (PP-15) |
| **CC6.2** registration & authorisation of users | E-mail verification (`registerUser`, `verifyEmail`), invitations hashed + e-mail-bound + role-gated (`inviteToOrg`, `acceptInvitation`), owner/admin-only role changes with last-owner protection (`org.routes.ts:103-170`) | E-mail change without re-verification (PP-06); team membership not consent-based/tenant-scoped (PP-04); no SCIM / bulk deprovisioning; no approval workflow for granting admin; no customer-visible access review |
| **CC6.3** role-based access, least privilege, removal | Member removal bumps `token_version`, revokes the member's API keys (`org.routes.ts:103-145`); API keys die when creator leaves org (`apiKeyOrJwt.ts`) | Realtime sockets survive removal (PP-02); no periodic access recertification (people with prod host/GitHub access); no joiner/mover/leaver checklist; orphaned data after org delete (PP-10) |
| **CC6.4** physical access | Inherited from the hosting provider (obtain its SOC 2 / ISO 27001 reports) or own facility controls if on-prem | Vendor evidence collection; office/endpoint physical security — **Org** |
| **CC6.5** disposal / data removal | `ON DELETE CASCADE` on core tables; project deletion use case | Org/user deletion & data-subject deletion workflow, S3 object deletion on annotation/project delete (not verified), retention schedule; FK gaps (PP-10) |
| **CC6.6** boundary protection | Only Caddy publishes 80/443 (`deploy/docker-compose.prod.yml`); API, Postgres and Redis sit on the private Compose network; Caddy automatic HTTPS with HTTP→HTTPS redirect and modern TLS defaults, rate limits (IP / IP+email / email / tenant / widget), `helmet` headers, SSRF guard, strict CORS | **No WAF**, no DDoS/bot controls, unrestricted container egress, no host firewall policy codified (restrict inbound to 22/80/443), `/metrics` exposure risk behind proxy (PP-07) |
| **CC6.7** transmission & movement of data | TLS at Caddy; Redis reachable only on the private Compose network; SMTP TLS option (`SMTP_SECURE`); HSTS header | TLS between Caddy and the API/dashboard is plain HTTP on the private network; Postgres `sslmode` not enforced (same-host network); MCP allows `http://` (PP-16); exports (CSV/PDF) contain customer data with no DLP/watermark |
| **CC6.8** malicious software | CSP on dashboard (`dashboard/vite.config.ts`), sandboxed review proxy, no `innerHTML` on dynamic data (`shared/src/safeText.ts`), no registry/image scanning yet (GHCR images are not scanned) | No endpoint protection policy for staff laptops (MDM), no malware scanning of uploads (PP-18), no SCA/SAST gates in CI |

### CC7 — System operations

| Criterion | Existing | Gaps |
|---|---|---|
| **CC7.1** detect configuration changes / new vulnerabilities | `server/src/config.ts` preflight; Compose/Caddy config under version control (`deploy/`) | No vulnerability management programme: no `npm audit`/Dependabot/Renovate (`.github/dependabot.yml` absent), no container/IaC scanning (Trivy/Checkov), no scheduled DAST; no host vulnerability scanning |
| **CC7.2** monitoring for anomalies | `pino` structured logs w/ secret redaction (`logger.ts`), request ids, Prometheus `http_requests_total` / latency (`infrastructure/metrics.ts`), Sentry hook (`sentry.ts`), `audit_logs` table (`recordAudit`) | Audit log lacks auth events and many mutations (PP-22); no alerting on failed-login bursts, privilege changes, API-key creation, export spikes; no central log aggregation/SIEM; container log retention is whatever Docker's log driver is configured for — SOC 2 Type II expects ≥ 12 months of evidence; audit log is mutable by the DB role |
| **CC7.3** evaluate security events | — | Event triage criteria, severity matrix, on-call rota — **Org** |
| **CC7.4** incident response | — | **No incident response plan/runbook**, no breach-notification procedure (contractual + GDPR 72 h), no tabletop exercises, no post-incident review template, no forensic log preservation — **Org** |
| **CC7.5** recovery | Documented `pg_dump` cron + restore procedure (`docs/DEPLOYMENT.md §4`), named Postgres volume, object-store versioning if enabled | Restore never evidenced; no RPO/RTO; no runbooks; no cross-region backup |

### CC8 — Change management

| Criterion | Existing | Gaps |
|---|---|---|
| **CC8.1** authorise, design, test, approve, implement changes | CI: lint + typecheck + unit tests with a real Postgres + Playwright e2e (`ci.yml`); actions pinned to commit SHAs; migrations via Knex; images published to GHCR from `main` only after all jobs pass (`docker-publish`, the only job with `packages: write`); deploys are a manual, reviewed step on the host; ADRs; DEPLOYMENT checklist (`docs/DEPLOYMENT.md §6`) | Evidence of **mandatory code review / branch protection / CODEOWNERS** (not visible in repo — verify in GitHub settings); deploy access is host SSH (restrict keys, log access; no long-lived cloud keys in CI — CI uses only the short-lived `GITHUB_TOKEN`); no SAST (CodeQL), SCA, secret scanning, SBOM/provenance signing; `:latest` is a moving tag — pin `<git-sha>` image tags in production (`DEPLOYMENT.md §3`); no change-ticket link, rollback criteria or emergency-change procedure; separation of duties (author ≠ approver ≠ deployer) not enforced; coverage is reported but not gated |

### CC9 — Risk mitigation

| Criterion | Existing | Gaps |
|---|---|---|
| CC9.1 business disruption | Multi-AZ prod DB, health checks, graceful shutdown | BCP/DR plan; cyber-insurance — **Org** |
| CC9.2 vendors & business partners | None | Vendor inventory + risk tiering (hosting provider, Stripe, SMTP provider, Sentry, GitHub, Google/GitHub OAuth, npm packages), DPAs, annual review of vendor SOC 2 reports, subprocessor list for customers — **Org** |

## 3. Additional criteria (brief)

### A1 — Availability

| Criterion | Existing | Gaps |
|---|---|---|
| A1.1 capacity & demand | Prometheus metrics (`monitoring` profile), `k6/` load scripts | No capacity plan or autoscaling policy evidence, no SLOs/error budgets, no status page |
| A1.2 environmental protections, backups, recovery infra | `pg_dump` backups with 14-day retention (cron example), named volumes, Redis optional (rate limits fail closed on widget/guest) | Single region; no off-host/cross-region backup copy evidenced; object-store backups not covered; single host, Postgres and Redis single instances with no failover |
| A1.3 recovery testing | one-shot `migrate` service + documented restore (`docs/DEPLOYMENT.md §4`) | **No restore test or DR exercise**; no documented RPO/RTO; no migration rollback (`down`) policy |

### C1 — Confidentiality

| Criterion | Existing | Gaps |
|---|---|---|
| C1.1 identify & maintain confidential information | Tenant isolation at app layer; PII scrub in logs/exports; hashed tokens | No data classification/inventory (annotations contain page content, session replay, console/network logs, guest e-mails, screenshots); RLS inert (PP-08); screenshots reachable by unauthenticated capability URL on the public object-store/CDN URL (64-bit random suffix, no expiry/revocation) |
| C1.2 disposal | Cascade deletes | Retention periods per data type, tested org/user purge incl. object storage and backups, customer data-export/deletion request process; FK gaps (PP-10) |

## 4. Existing control inventory (for the auditor's "system description")

Authentication & session: bcrypt, e-mail verification, single-use hashed reset/verify tokens, rate limits, lockout on
shared links, JWT + `token_version`, CSRF double-submit, OAuth state/PKCE. Authorization: org + project ACL, RBAC,
API-key scopes + allow-list, widget keys origin-bound with quotas. Input/egress: Zod validation, SSRF guard, sandboxed
review proxy, CSV-injection neutralisation, security headers/CSP. Data protection: TLS at edge, encryption at rest (host volume encryption, object store), env-file secrets, hashed credentials/tokens, secret redaction in logs. Observability: structured logs, request ids,
Prometheus, Sentry, audit log table. Delivery: CI with tests + e2e, pinned actions, versioned Compose/Caddy deployment config,
GHCR image publishing, config preflight that refuses unsafe prod config.

## 5. Prioritised checklist

### P0 — fix before any customer-facing "secure" claim (code, days–weeks)
1. PP-01/PP-02/PP-03/PP-04 tenant side channels (rooms for all events, disconnect on removal, validate `teamId`, org-scope teams).
2. PP-05 enforce `requireWriteAccess` globally; admin-only webhook/api-key listing.
3. PP-06 e-mail change flow (re-auth + verify new address + revoke sessions).
4. PP-07 require `METRICS_TOKEN` when exposed; PP-08 decide RLS (implement with a least-privilege DB role, or remove).
5. Keep CI free of long-lived cloud credentials (only the short-lived `GITHUB_TOKEN`); enable branch protection + required reviews + CODEOWNERS on `main` and restricted SSH access to the production host.
6. Add Dependabot/Renovate, `npm audit --omit=dev` gate, CodeQL, gitleaks, container scan (Trivy) to CI. Publish `SECURITY.md` (disclosure contact).

### P1 — control gaps with code + ops work (weeks–2 months)
7. Audit logging: record auth events, exports, share/portal/board/integration changes, invitations, org switch; add actor IP/UA/request-id; append-only (revoke UPDATE/DELETE from app role); ship to a separate log account/bucket with ≥ 12-month retention (CloudWatch → S3 + Object Lock).
8. Ship host audit logs (auditd/journald, SSH logins) to central storage and add host intrusion detection (e.g. fail2ban/Wazuh); add alerts for root/SSH login, failed-login spikes, API-key creation, export bursts.
9. MFA (TOTP/WebAuthn) for all users, enforced for owners/admins; SSO (OIDC/SAML) for enterprise; absolute session lifetime + session list/revoke UI (PP-15).
10. Password policy upgrade + breached-password check (PP-12); WAF/bot protection in front of Caddy (e.g. Caddy + Coraza or a CDN WAF); host firewall and container egress allow-list.
11. Data lifecycle: FKs/cascade (PP-10), org/user deletion job incl. S3 + search of backups policy, retention schedule, customer export; encrypt webhook secrets (PP-11); signed/expiring screenshot URLs or CloudFront signed cookies.
12. Backups/DR: raise retention (≥ 14–35 days), copy dumps off-host and off-site and replicate object storage, **perform and document a restore test**, define RPO/RTO, runbook, quarterly exercise.

### P2 — organizational programme (months; needed for the audit itself)
13. Choose scope (Security + Availability + Confidentiality), report type (Type I → Type II) and auditor; consider a compliance-automation platform (Vanta/Drata/Secureframe) to collect evidence.
14. Policy set (information security, access control, change management, incident response, BCP/DR, vendor management, data classification/retention, acceptable use, secure SDLC, risk management, HR security) with named owners and annual review.
15. Risk register + annual risk assessment; vendor inventory, DPAs, collect hosting-provider/Stripe/GitHub SOC 2 reports, subprocessor list.
16. HR controls: background checks, confidentiality agreements, security awareness training, onboarding/offboarding checklists tied to access removal within 24 h.
17. Quarterly access reviews (host SSH keys, GitHub, DB, `.env.production` secret holders, CI secrets, production dashboards, support tooling) with signed evidence.
18. Incident response plan + on-call + breach-notification templates; tabletop exercise twice a year; post-incident reviews.
19. Endpoint management (MDM, disk encryption, screen lock), password manager, hardware keys for admins.
20. Annual external penetration test and quarterly vulnerability scans with tracked remediation SLAs (critical 7 d / high 30 d). `docs/SECURITY_REVIEW.md` is an internal precursor, **not a substitute**.
21. Customer-facing trust documentation: system description, shared-responsibility for self-hosters (`PINPOINT_SELF_HOST`), security whitepaper, status page, SLA.

## 6. Notes for self-hosted deployments
The server's boot preflight (`server/src/config.ts`) is a good technical control for operators but SOC 2 covers the
service organization's *hosted* service. A self-hosting customer inherits none of the hosted controls; document the
shared-responsibility split (secrets, TLS, backups, patching, log retention) in `docs/DEPLOYMENT.md`.

## 7. What this document cannot establish
Whether branch protection / required reviewers / MFA on staff accounts / hosting-account/host hygiene are enabled (not visible in
the repo), how production is actually operated, and whether any control operates effectively over time (the substance of
a Type II). Treat every "Existing" cell as *design evidence*, not *operating evidence*.
