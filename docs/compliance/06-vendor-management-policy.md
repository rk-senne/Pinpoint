# 06 — Vendor Management Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner>` | `<management>` | Annual review of each vendor; inventory reviewed quarterly | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. Rules
1. Every vendor that stores, processes or can access customer data, or that is in the delivery path (hosting, code, CI), is listed in the inventory below **before** use.
2. Tier by risk: **T1** holds customer data or production access; **T2** supports operations without customer data; **T3** other. T1 needs a documented review: security report (SOC 2 / ISO 27001) or equivalent answers, DPA where personal data is processed, and an exit plan.
3. Review annually: re-read the vendor's latest report/terms, confirm MFA on our account, confirm we still need it.
4. Customers get an up-to-date subprocessor list `<URL>`. Vendors are only the ones **actually enabled** in a given deployment.
5. Outbound calls from the Pinpoint server go only through `safeFetch` (SSRF guard); new egress destinations need Security owner approval.
6. Open-source dependencies are vendors too: see [08](08-secure-development-policy.md) (SCA, pinned actions).

## 2. Inventory — which are subprocessors depends on deployment choices

| Vendor | Used for | Customer data? | Enabled when | Tier | Evidence to collect |
|---|---|---|---|---|---|
| **Hosting provider** `<Hetzner / DigitalOcean / OVH / Scaleway / on-prem>` | VM, disk, network (everything incl. DB, screenshots, backups) | Yes (all) | Always (for the hosted service) | T1 | ISO 27001 / SOC 2 report or certificate, DPA, data-centre location |
| **Registrar / DNS** `<Cloudflare, Porkbun, …>` | Domain, DNS (DNS hijack = account takeover risk) | No (metadata) | Always | T2 | MFA on, registrar lock |
| **Let's Encrypt** (via Caddy) | TLS certificates | No | Always | T3 | — |
| **GitHub** (+ GHCR, Actions) | Source, CI, container registry | No customer data (code only; CI uses throwaway data) | Always | T2 | GitHub SOC 2 report; org MFA enforced |
| **Transactional SMTP** `<Brevo / Resend / SES / Mailgun / Postmark>` | Verification, reset, notification e-mails | Yes (recipient e-mail, names, notification text) | When `SMTP_*` points at it | T1 | DPA, SOC 2/ISO, SPF/DKIM/DMARC set |
| **Object storage** `<Cloudflare R2 / Backblaze B2 / S3>` | Screenshots + markup (S3 driver) and/or off-box backups | Yes | `STORAGE_DRIVER=s3` or off-box backup target | T1 | DPA, SOC 2, bucket private, backups encrypted client-side |
| **Slack, Jira/Atlassian, Linear, GitHub, ClickUp, Asana** | "Send to…" / auto-notify, using the **customer's** own account and OAuth consent | Yes (annotation text/links the customer chooses to send) | Only per customer who connects it; **customer-chosen**, not our subprocessor by default | T2 (customer-directed) | Note in customer docs; secrets encrypted at rest |
| **Google / GitHub OAuth** | Optional sign-in | Yes (name, e-mail) | When `GOOGLE_*`/`GITHUB_CLIENT_*` set | T2 | Terms |
| **Stripe** | Billing (card data is Stripe's, not stored by us) | Yes (billing contact) | When `STRIPE_SECRET_KEY` set | T1 | Stripe SOC 2 / PCI AoC |
| **Sentry or other error tracking** | Error reports | Possibly (stack traces) | When `sentry.ts` DSN configured | T1 if enabled | Scrubbing config, DPA |
| **Chrome Web Store, AMO, Apple** | Extension distribution | No customer data | Per store used | T3 | Developer account MFA |
| **Compliance/pen-test/auditor firms** | Audit | Access to evidence | When engaged | T2 | NDA |
| **npm registry & dependencies** | Build-time supply chain | No | Always | T2 | Lockfile, SCA, Dependabot |

Remove rows that do not apply to your deployment; the hosted-service subprocessor list is exactly the rows with
"Customer data? Yes" that you enabled.

## 3. Onboarding checklist (new T1 vendor)
Business need · data shared · DPA signed · security report reviewed (exceptions noted) · MFA/least-privilege on our account · exit/data-return plan · added to inventory and the customer subprocessor list (with notice period if contractually required).

## 4. Offboarding
Delete our data from the vendor (request confirmation), revoke tokens/keys, rotate any shared secret, update the inventory and subprocessor list.

## 5. Sign-off
Approved by `<name>` on `<date>`.
