# Personal Data Breach Response

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** This is the operator's internal procedure (published so customers know what to expect). It supplements `docs/compliance/04-incident-response-plan.md`. Have a lawyer confirm the notification thresholds for your situation, and keep contact details current.

## 1. Scope and definitions

A **personal data breach / security compromise** is any event where personal information processed by {{COMPANY_NAME}} is accessed, acquired, disclosed, altered, lost or destroyed without authorisation — e.g. leaked credentials, a database or backup exposed, cross-tenant access, a lost laptop with production access, a compromised e-mail account. **POPIA s.22** is triggered where there are *reasonable grounds to believe* personal information has been accessed or acquired by an unauthorised person; **GDPR Art. 4(12)/33** covers breaches of security leading to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of or access to personal data.

## 2. Who does what

| Role | Who | Duty |
|---|---|---|
| Incident lead | {{INFORMATION_OFFICER}} (Information Officer) or their deputy | Owns the incident, decisions and the log; signs off notifications |
| Technical responder | the engineer on call | Contain, investigate, preserve evidence |
| Communications | Incident lead | Customer, regulator and data-subject notices |
| Counsel | {{COMPANY_NAME}}'s lawyer | Advises on thresholds, wording and cross-border duties |

Contact: {{SECURITY_EMAIL}} (inbound reports) · {{INFORMATION_OFFICER_EMAIL}}.

## 3. Timelines (the clocks)

| Obligation | Who notifies whom | Deadline |
|---|---|---|
| Processor → customer (controller) | {{COMPANY_NAME}} → affected customers | **Without undue delay, and within 48 hours** of becoming aware (our DPA §6); POPIA s.21(2) says "immediately" |
| GDPR Art. 33 / UK GDPR Art. 33 | Controller → supervisory authority / ICO | **Without undue delay and, where feasible, within 72 hours** of becoming aware, unless the breach is unlikely to result in a risk to individuals. If late, give reasons |
| GDPR Art. 34 | Controller → data subjects | **Without undue delay** when the breach is likely to result in a **high** risk |
| POPIA s.22 | Responsible party → **Information Regulator** and affected data subjects | **As soon as reasonably possible** after discovery, taking into account law-enforcement needs and measures reasonably necessary to determine the scope and restore integrity of the system (no fixed hour count) |
| CCPA / California breach law | Business → affected California residents (and the AG above 500 residents) | "In the most expedient time possible and without unreasonable delay" |

The 72 h GDPR clock starts when we are **aware** (a reasonable degree of certainty a breach occurred), not when the investigation ends: notify in phases. Where {{COMPANY_NAME}} is only the **processor**, the customer owns the regulator and data-subject notices; we provide the facts and help. Where {{COMPANY_NAME}} is the **controller / responsible party** (account and security data), we notify the Information Regulator (and EU/UK authorities where applicable) ourselves.

## 4. Procedure

1. **Detect & report.** Anyone who suspects a breach e-mails {{SECURITY_EMAIL}} immediately. Open an incident record (time of discovery = the clock start). Severity: High if personal data of more than one tenant, credentials/secrets or backups are exposed.
2. **Contain (first hours).** Revoke exposed credentials and sessions (bump `token_version`, rotate `JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY` via the documented procedure, revoke API keys), close the hole, isolate hosts, preserve logs and the append-only `audit_logs`. Do not delete evidence.
3. **Assess.** Determine what data, whose (which tenants, how many data subjects, which categories — note screenshots/replay can contain third-party data), when, how, whether it was encrypted/hashed (bcrypt hashes, AES-GCM-encrypted integration secrets reduce risk), and the likelihood and severity of harm. Use `audit_logs` (actor, IP, request id) to scope. Record the decision on whether it is notifiable and *why* (Art. 33(5) requires documenting **every** breach, including non-notifiable ones).
4. **Notify customers** (if processor) — within 48 h, using the template in §5. Update as facts emerge.
5. **Notify regulators.**
   * **South Africa — Information Regulator** (POPIA s.22): through the Regulator's current security-compromise reporting channel on its eServices portal (<https://inforegulator.org.za> — confirm the current form before an incident; enquiries `enquiries@inforegulator.org.za`, tel. 010 023 5200); do so **as soon as reasonably possible**, then supplement.
   * **EU/UK:** the lead/competent supervisory authority or the ICO within 72 h where required.
6. **Notify data subjects** where required (POPIA s.22(4): in writing — e-mail to the last known address, prominent website notice, or as the Regulator directs — with enough information to let them protect themselves: the nature of the compromise, the possible consequences, measures taken, recommended protective steps and, if known, the identity of the unauthorised person). Delay only if a public body or the Regulator determines notification would impede a criminal investigation.
7. **Recover & learn.** Restore from clean backups (re-applying recorded erasures — see [Data Retention](./DATA_RETENTION.md) §2), verify integrity, run a blameless post-mortem within 10 working days, update controls and the risk register (`docs/compliance/11-risk-assessment-and-register.md`).

## 5. Information to provide (customer and regulator notices)

Provide what is known, add the rest as discovered (GDPR Art. 33(3)):

* nature of the breach, categories and approximate number of data subjects and records, affected tenants;
* when it happened, when and how it was discovered;
* likely consequences;
* contact details (Information Officer / security contact);
* measures taken or proposed to address and mitigate it;
* whether data was encrypted/hashed and whether keys were exposed;
* for POPIA: the identity of the unauthorised person if known, and recommendations to data subjects.

**Customer notice template**

> Subject: Security incident affecting your Pinpoint data — [reference]
> On [date/time UTC] we became aware that [short description]. [Categories of data] relating to [approx. number] people in your organisation [may have been/were] [accessed/disclosed/lost]. [Encrypted/hashed? yes/no]. We have [containment]. We recommend you [actions, e.g. rotate API keys, reset passwords]. We will update you by [time]. Contact: {{INFORMATION_OFFICER}}, {{SECURITY_EMAIL}}.

## 6. Records

Keep for at least 5 years: the incident log, assessment and decision, notices sent (with timestamps), evidence references and the post-mortem (GDPR Art. 33(5); POPIA accountability). Test this procedure with a table-top exercise at least annually.
