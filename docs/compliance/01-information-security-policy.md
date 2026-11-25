# 01 — Information Security Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner name/role>` | `<CEO / founder>` | Annual and after any major incident | `0.1 draft` | `<date>` |

Template — not adopted until the fields above are filled and approved. No compliance claim is made by this file.

## 1. Purpose and scope
Protect the confidentiality, integrity and availability of `<Company>`'s Pinpoint service and the customer feedback data
it holds (annotation text, comments, screenshots, session replays, console/network captures, guest e-mail addresses).
Applies to all staff, contractors, production hosts, the GitHub organisation, CI, and vendors that touch customer data.
Self-hosting customers run their own deployment; this policy covers only the service `<Company>` operates.

## 2. Roles
- **Security owner** (named above): maintains policies, runs the risk register ([11](11-risk-assessment-and-register.md)), is the incident commander by default ([04](04-incident-response-plan.md)).
- **Engineering lead:** owns change and secure-development controls ([03](03-change-management-policy.md), [08](08-secure-development-policy.md)).
- **Management (approver):** approves policies, accepts residual risk, funds remediation.
- **Everyone:** follows [10 Acceptable Use](10-acceptable-use-policy.md) and reports suspected incidents immediately.

## 3. Principles
1. Least privilege and need-to-know ([02](02-access-control-policy.md)).
2. Tenant data isolation is non-negotiable: application checks **and** PostgreSQL row-level security with the API running as the unprivileged `pinpoint_app` role (`docs/SECURITY_REVIEW.md` PP-08). The API must never use owner/superuser database credentials.
3. Secrets live only in `deploy/.env.production` (mode 600) or the CI secret store; never in git, tickets or chat.
4. Production defaults are secure; the boot preflight (`server/src/config.ts`) refuses weak secrets and must not be bypassed on an exposed deployment.
5. Encrypt in transit (TLS at Caddy) and at rest (provider/host volume encryption; integration tokens and webhook secrets are application-encrypted with `INTEGRATION_ENCRYPTION_KEY`).
6. Everything security-relevant is logged ([09](09-logging-monitoring-policy.md)) and recoverable ([05](05-business-continuity-backup-dr.md)).

## 4. Policy set and review
All policies in `docs/compliance/` are reviewed at least annually by their owner; the Security owner records the review
(date, reviewer, changes) in the policy's git history or a review log `<location>`.

## 5. Training and awareness
Staff complete security awareness training on joining and annually `<provider/method>`; developers additionally follow [08](08-secure-development-policy.md).

## 6. Exceptions
Written, time-boxed, approved by the Security owner and logged with a compensating control and an expiry date.

## 7. Enforcement
Violations may lead to access removal and disciplinary action `<per HR policy>`.

## 8. Sign-off
Approved by `<name>` on `<date>`.
