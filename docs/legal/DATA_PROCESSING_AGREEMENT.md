# Data Processing Agreement

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** This DPA is built on GDPR Art. 28(3), POPIA s.20–21 and the CCPA service-provider rules, and incorporates the European Commission's Standard Contractual Clauses by reference. A lawyer must review it, and the SCC annexes below must be checked against the signed text, before it is relied on.

This Data Processing Agreement ("**DPA**") forms part of the [Terms of Service](./TERMS_OF_SERVICE.md) between **{{COMPANY_NAME}}** ("**Processor**", "**Operator**", "**Service Provider**", registration no. {{COMPANY_REG_NO}}, {{COMPANY_ADDRESS}}) and the customer that accepted the Terms ("**Controller**", "**Responsible Party**", "**Business**", "**Customer**"). It applies to personal information in **Customer Content** that the Processor hosts for the Customer through the hosted Pinpoint service. It does **not** apply to a self-hosted deployment (no data reaches the Processor) or to the Processor's own account/billing data, for which it is controller (see the [Privacy Policy](./PRIVACY_POLICY.md)).

**Terms.** "Personal Data" includes "personal information" under POPIA and "personal information" under CCPA. "Controller", "Processor", "Data Subject", "Personal Data Breach", "Supervisory Authority" have their GDPR meanings; "Responsible Party", "Operator", "Regulator" (the Information Regulator) have their POPIA meanings. "**Data Protection Law**" means, as applicable: Regulation (EU) 2016/679 (GDPR); the UK GDPR and Data Protection Act 2018; the Protection of Personal Information Act 4 of 2013 (POPIA); and the California Consumer Privacy Act as amended by the CPRA (CCPA).

## 1. Roles and instructions

1.1 The Customer is the Controller / Responsible Party of the Personal Data in Customer Content and the Processor is its Processor / Operator. (If the Customer is itself a processor for its own client, the Processor is a sub-processor and the Customer warrants it has authority to give these instructions.)

1.2 The Processor will process Personal Data **only on the Customer's documented instructions** — these Terms, this DPA, and the Customer's use and configuration of the Service (including API calls, integrations and deletion requests) — unless Union, Member State, UK or South African law requires otherwise, in which case it will inform the Customer beforehand unless the law forbids that (GDPR Art. 28(3)(a); POPIA s.20). The Processor will tell the Customer if it believes an instruction infringes Data Protection Law.

1.3 The Processor will not process Customer Personal Data for its own purposes, and — for CCPA — will **not sell or share** it, retain, use or disclose it outside the direct business relationship or for any purpose other than the business purposes in Annex I, combine it with other personal information, or process it contrary to the CCPA (Cal. Civ. Code §1798.100(d), §1798.140(ag)); it will notify the Customer if it can no longer meet its CCPA obligations, and the Customer may take reasonable steps to stop and remediate unauthorised use.

## 2. Customer responsibilities

The Customer is responsible for the lawfulness of the processing: having a legal basis and giving the notices required to its reviewers, guests and users (including about screenshots, console/network captures and session replay), choosing which captures are enabled, and not uploading special categories of personal data or children's data (see the [Acceptable Use Policy](./ACCEPTABLE_USE_POLICY.md)).

## 3. Confidentiality

Everyone the Processor authorises to process Personal Data is bound by confidentiality, and access is limited to those who need it to provide the Service (GDPR Art. 28(3)(b); POPIA s.20).

## 4. Security

The Processor implements and maintains the technical and organisational measures in **Annex II** (GDPR Art. 32; POPIA s.19 and s.21). They may be updated provided overall security is not materially reduced.

## 5. Sub-processors

5.1 The Customer gives **general written authorisation** to the sub-processors listed in [SUBPROCESSORS.md](./SUBPROCESSORS.md).

5.2 The Processor will give **30 days' prior notice** of an intended addition or replacement (by e-mail to account owners and by updating that page). The Customer may object on reasonable data-protection grounds within that period; the parties will work in good faith to resolve it, failing which the Customer may terminate the affected service with a pro-rata refund.

5.3 The Processor imposes on each sub-processor, by written contract, data-protection obligations no less protective than this DPA and remains **liable** to the Customer for their performance (GDPR Art. 28(4); POPIA s.21).

## 6. Assistance

Taking into account the nature of processing, the Processor will, with reasonable effort and at no extra charge for self-service functions:

* **Data-subject requests** (GDPR Ch. III; POPIA s.23–24; CCPA): promptly forward requests it receives about Customer Content to the Customer and not respond itself except to redirect. The Customer can self-serve via **Settings → Privacy**: *Export organisation data* (`GET /api/v1/privacy/org-export`), project CSV/PDF export, deleting annotations and projects, and *Delete organisation* (`DELETE /api/v1/privacy/org`). Individuals' own copies are available via `GET /api/v1/privacy/export`. Further assistance beyond self-service is provided at reasonable cost.
* **Security, breach notification, DPIAs and prior consultation** (GDPR Art. 32–36): provide information reasonably needed.
* **Breach notification:** the Processor will notify the Customer **without undue delay and in any event within 48 hours** after becoming aware of a Personal Data Breach affecting Customer Personal Data (POPIA s.21(2): "immediately" on reasonable grounds to believe the information has been accessed or acquired by an unauthorised person; GDPR Art. 33(2)), with the information in [Breach Response](./BREACH_RESPONSE.md) §5 as it becomes available. The Customer remains responsible for notifying Supervisory Authorities / the Information Regulator and data subjects (GDPR Art. 33–34; POPIA s.22), and the Processor will help.

## 7. Return and deletion

7.1 On termination, or earlier at the Customer's request, the Processor will delete Customer Personal Data (or return it via export) as the Customer chooses. Self-service: **export first** (Settings → Privacy → *Export organisation data*), then **Delete organisation** — a transactional deletion of the organisation's database records plus its screenshot objects (local or S3).

7.2 Backups containing deleted data expire on the schedule in [Data Retention](./DATA_RETENTION.md) (default 14 days, at most 35) and are not restored to production without re-applying recorded deletions. Copies the law requires the Processor to keep are retained and protected until the legal period ends.

## 8. Audits and information

The Processor will make available information necessary to demonstrate compliance with Art. 28 and allow for audits by the Customer or its auditor on **30 days' notice, no more than once a year** (or after a Personal Data Breach), during business hours, under confidentiality and without unreasonable disruption, at the Customer's cost. The Processor may satisfy this in the first instance by providing its current security documentation (e.g. `docs/SECURITY_REVIEW.md`, the compliance policy set and the answers to a reasonable security questionnaire). These are internal self-assessments and **not** a certification or an independent audit.

## 9. International transfers

9.1 The Processor operates from South Africa. Customer Personal Data is hosted in {{HOSTING_REGION}} ({{HOSTING_PROVIDER}}). Where Customer Personal Data subject to the GDPR is transferred to the Processor in a country without an EU adequacy decision (for example South Africa), or onward to a sub-processor in such a country, the parties agree that the **Standard Contractual Clauses adopted by Commission Implementing Decision (EU) 2021/914** ("**SCCs**") are incorporated into this DPA by reference and apply as follows:

| SCC element | Choice |
|---|---|
| Modules | **Module Two** (Controller → Processor) for Customer ↔ Processor; **Module Three** (Processor → Processor) for Processor ↔ sub-processor |
| Clause 7 (docking) | Included |
| Clause 9(a) (sub-processors) | **Option 2, general written authorisation**, 30 days' notice (§5) |
| Clause 11(a) (independent dispute resolution) | Optional wording **not** included |
| Clause 13 / Annex I.C (competent authority) | The Supervisory Authority of the Customer's establishment (or of its EU representative / where its data subjects are) |
| Clause 17 (governing law) | **Option 1:** the law of {{SCC_GOVERNING_LAW}} |
| Clause 18(b) (forum) | The courts of {{SCC_GOVERNING_LAW}} |
| Annex I | Annex I below |
| Annex II | Annex II below |
| Annex III | [SUBPROCESSORS.md](./SUBPROCESSORS.md) |

9.2 **UK:** for UK GDPR transfers, the SCCs apply as amended by the **UK International Data Transfer Addendum to the EU SCCs** issued by the ICO (version B1.0, in force 21 March 2022), whose Tables 1–4 are completed by reference to this DPA and its annexes. **Switzerland:** the SCCs apply with the references to the GDPR read as references to the Swiss FADP.

9.3 **South Africa (POPIA s.72):** the Processor, and each sub-processor listed, is bound by a binding agreement providing a level of protection substantially similar to POPIA's conditions for lawful processing, including on onward transfer.

9.4 If the SCCs conflict with this DPA, the SCCs prevail. The Processor will tell the Customer if it can no longer comply with the SCCs, and will notify and challenge, where lawful, any government access request that goes beyond what is necessary and proportionate.

## 10. POPIA operator provisions

In addition to the above, and as required by POPIA s.20 and s.21 the Processor: (a) processes Customer Personal Data only with the knowledge or authorisation of the Responsible Party and treats it as confidential, not disclosing it unless required by law or in the course of its duties; (b) establishes and maintains the security measures in Annex II; and (c) **notifies the Customer immediately** (and in any event within the period in §6) where there are reasonable grounds to believe the information has been accessed or acquired by an unauthorised person.

## 11. Liability, term, order of precedence

Liability under this DPA is subject to the limits in the Terms, except where the law (including the SCCs) does not allow limitation. The DPA lasts as long as the Processor processes Customer Personal Data. If it conflicts with the Terms, this DPA prevails on the processing of Personal Data. Contact for data-protection matters: {{CONTACT_EMAIL}}; Information Officer: {{INFORMATION_OFFICER}} ({{INFORMATION_OFFICER_EMAIL}}).

---

## Annex I — Description of processing

**A. Parties.** *Data exporter / Controller:* the Customer identified at registration (name, address and contact are those in the Customer's account; role: Controller / Responsible Party). *Data importer / Processor:* {{COMPANY_NAME}}, {{COMPANY_ADDRESS}}, contact {{CONTACT_EMAIL}}, Information Officer {{INFORMATION_OFFICER}} (role: Processor / Operator).

**B. Description of transfer and processing.**

| Item | Description |
|---|---|
| Subject matter | Hosting and operating the Pinpoint feedback platform for the Customer |
| Nature and purpose | Storage, retrieval, display, organisation, transmission to Customer-chosen integrations, backup, security monitoring, deletion — to provide the Service the Customer has requested |
| Duration | The term of the Terms plus the deletion periods in §7 |
| Categories of data subjects | The Customer's staff and invited members; reviewers, clients and guests who submit feedback; people whose data appears on pages that are captured in screenshots, console/network captures or session replay |
| Categories of Personal Data | Names, e-mail addresses and roles; free-text feedback and comments; page URLs and DOM selectors; browser/OS/viewport/user-agent; IP addresses and user-agent in audit records; screenshots and captures (content unknown to the Processor and decided by the Customer); guest names and e-mail addresses; integration identifiers |
| Special categories / sensitive data | **None intended; prohibited** by the Acceptable Use Policy. The Customer must not upload any. If it does so inadvertently, the safeguards in Annex II apply (access controls, encryption in transit, deletion on request) |
| Frequency | Continuous, for the term |
| Retention | As in [Data Retention](./DATA_RETENTION.md) and §7 |
| Sub-processors (Annex III) | [SUBPROCESSORS.md](./SUBPROCESSORS.md) (processing the same subject matter, nature and duration) |

**C. Competent supervisory authority.** As in the SCC table above.

## Annex II — Technical and organisational measures

The measures below are those implemented in the Pinpoint code and deployment templates at the date above; the evidence is in the repository so a customer can verify it. They are a description of controls, **not** a certification (see `docs/SOC2_READINESS.md`, which is a gap assessment).

| Domain | Measure | Where to verify |
|---|---|---|
| Encryption in transit | TLS 1.2+ for all external traffic via the bundled Caddy reverse proxy with automatic HTTPS; HSTS and security headers (helmet) | `deploy/Caddyfile`, `deploy/docker-compose.prod.yml`, `server/src/composition/container.ts` |
| Encryption at rest | Integration OAuth tokens, client secrets and webhook signing secrets encrypted with **AES-256-GCM** (`INTEGRATION_ENCRYPTION_KEY`, required on exposed deployments). Disk/volume encryption is a host-level control chosen by the operator | `server/src/services/secretBox.ts`; `docs/DEPLOYMENT.md` |
| Authentication | Passwords hashed with **bcrypt**; common-password blocklist and minimum length; e-mail verification; per-IP and per-(IP, e-mail) rate limiting on auth endpoints; session invalidation on password change/logout (`token_version`) | `server/src/domain/auth`, `server/src/middleware/authRateLimit.ts` |
| Session security | `HttpOnly` + `Secure` + `SameSite=Lax` `__Host-` cookies; CSRF double-submit token **bound to the session**; bearer tokens for the extension | `server/src/middleware/sessionCookies.ts`, `csrf.ts` |
| Access control | Roles owner / admin / member / viewer enforced on every route (viewer write-guard); org-scoped API keys with scopes (`feedback:read`, `feedback:write`), hashed at rest, restricted to automation routes | `server/src/adapters/inbound/http/access.ts`, `apiKeys.routes.ts` |
| **Tenant isolation** | Every query is scoped by `org_id` in application code **and** by **PostgreSQL Row-Level Security** (the API connects as the unprivileged `pinpoint_app` role, `NOBYPASSRLS`; the tenant context is set per request from the verified session; with no context every policy fails closed) | migration `20261125000101_row_level_security.ts`, `server/src/infrastructure/tenantContext.ts`, `docs/SECURITY_REVIEW.md` PP-08 |
| Audit logging | Append-only `audit_logs` (database triggers reject edits/deletes) recording actor, action, resource, IP, user-agent and request id for security-relevant events, including exports and erasures | migration `20261118000101_audit_log_append_only.ts` |
| Network & request safety | SSRF egress guard (`safeFetch`: https-only, DNS-pinned to validated public IPs, private/metadata ranges blocked, size and time caps) for all outbound HTTP (webhooks, integrations, review proxy); input sanitisation; request-size limits; Content-Security-Policy | `server/src/services/egressGuard.ts`, `dashboard/vite.config.ts` |
| Data minimisation & capture safety | Password fields and `data-fl-redact` / `[data-fl-private]` regions masked before screenshot/console/network/replay capture; capture toggles per host; screenshot redaction; widget/diagnostic text scrubbed of obvious secrets | `extension/`, `widget/`, `server/src/services/screenshotRedaction.ts` |
| Secure configuration | Boot **preflight** refuses to start an exposed deployment with default or missing secrets (`JWT_SECRET`, `DB_PASSWORD`, `CORS_ORIGIN`, `OAUTH_STATE_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `METRICS_TOKEN`) | `server/src/config.ts` |
| Availability & backup | Health probes; `deploy/backup.sh` database + screenshot backups with configurable retention (`BACKUP_RETENTION_DAYS`); restore procedure | `deploy/backup.sh`, `deploy/restore.sh`, `docs/compliance/05-business-continuity-backup-dr.md` |
| Vulnerability management | Pinned exact dependency versions and pinned CI actions; internal adversarial security review with tracked findings (PP-01…PP-25); CI standards gate | `CONTRIBUTING.md`, `docs/SECURITY_REVIEW.md`, `scripts/check-standards.mjs` |
| Organisational | Policy set (information security, access control, change management, incident response, vendor management, retention, secure development, logging) — drafts to be adopted by the operator | `docs/compliance/` |
| Data-subject rights tooling | Self-service export, account erasure and organisation erasure (with screenshot-object deletion) | `server/src/adapters/inbound/http/privacy.routes.ts` |
| Personnel | Access to production limited to the operator's staff who need it; confidentiality obligations | operator procedure |
| Incident response | Documented procedure with 72 h GDPR / POPIA s.22 timelines | [BREACH_RESPONSE.md](./BREACH_RESPONSE.md) |

## Annex III — Sub-processors

See [SUBPROCESSORS.md](./SUBPROCESSORS.md).
