# Pinpoint legal pack

> **Not legal advice — have a lawyer review before relying on it.**
> These documents are drafts written by an engineer from the product's actual data flows and from the public texts listed under *Sources*. They are a starting point for a qualified attorney or privacy professional (in South Africa, ideally one familiar with POPIA and GDPR), not a substitute for one. They make **no compliance claim**: nothing here certifies that {{COMPANY_NAME}} complies with POPIA, GDPR, UK GDPR, CCPA/CPRA or any other law. Until a lawyer has reviewed them and the placeholders are filled in, do not publish them as your terms.

## What is in this folder

| Document | Audience | Purpose |
|---|---|---|
| [TERMS_OF_SERVICE.md](./TERMS_OF_SERVICE.md) | Customers and their users | Contract for the hosted Pinpoint service |
| [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) | Everyone | GDPR Art. 13/14, UK GDPR, POPIA s.18, CCPA/CPRA notice at collection |
| [DATA_PROCESSING_AGREEMENT.md](./DATA_PROCESSING_AGREEMENT.md) | Customers (controllers / responsible parties) | GDPR Art. 28 + POPIA operator terms + SCC reference + CCPA service-provider terms |
| [SUBPROCESSORS.md](./SUBPROCESSORS.md) | Customers | Who else touches customer data |
| [COOKIE_POLICY.md](./COOKIE_POLICY.md) | Everyone | Every cookie / storage item, with the legal basis for not showing a banner |
| [ACCEPTABLE_USE_POLICY.md](./ACCEPTABLE_USE_POLICY.md) | Customers and their users | What may not be done with the service |
| [DATA_RETENTION.md](./DATA_RETENTION.md) | Everyone / auditors | How long each data set is kept, mapped to what the code really does |
| [BREACH_RESPONSE.md](./BREACH_RESPONSE.md) | Operator (internal) + customers | 72 h GDPR / POPIA s.22 breach handling procedure |

The dashboard renders the Terms, Privacy Policy, Cookie Policy and Sub-processors (and the rest) from these Markdown files at build time (`/legal/terms`, `/legal/privacy`, `/legal/cookies`, `/legal/subprocessors`, …). **Edit the Markdown, rebuild the dashboard** — there is no second copy to keep in sync. Placeholders are not substituted automatically: search-and-replace the `{{…}}` tokens in this folder before you build.

## Placeholders to fill in

Replace every token below (search for `{{`) across `docs/legal/*.md` **and** `extension/store/privacy-policy.md`.

| Placeholder | Meaning | Example | Your value |
|---|---|---|---|
| `{{COMPANY_NAME}}` | Legal name of the entity that operates the hosted service (the controller / operator) | `Example (Pty) Ltd` | |
| `{{COMPANY_REG_NO}}` | Company registration number (CIPC for South Africa) | `2026/123456/07` | |
| `{{COMPANY_ADDRESS}}` | Registered / physical address (POPIA s.18(1)(b) requires the responsible party's name **and address**) | `1 Example Street, Cape Town, 8001, South Africa` | |
| `{{CONTACT_EMAIL}}` | General and privacy contact mailbox that is actually monitored | `privacy@example.com` | |
| `{{SECURITY_EMAIL}}` | Where researchers and customers report vulnerabilities / incidents | `security@example.com` | |
| `{{INFORMATION_OFFICER}}` | POPIA Information Officer (for a company: by default the CEO or equivalent head; must be **registered with the Information Regulator**) | `Jane Doe` | |
| `{{INFORMATION_OFFICER_EMAIL}}` | Information Officer contact | `io@example.com` | |
| `{{GOVERNING_LAW}}` | Law governing the Terms | `the laws of the Republic of South Africa` | |
| `{{COURTS}}` | Courts with jurisdiction | `the High Court of South Africa, Western Cape Division` | |
| `{{SERVICE_URL}}` | Public origin of the hosted service | `https://app.example.com` | |
| `{{EFFECTIVE_DATE}}` | Date the documents take effect (also bump `TERMS_VERSION` in `server/src/domain/privacy/termsVersion.ts`) | `2026-12-01` | |
| `{{HOSTING_PROVIDER}}` / `{{HOSTING_REGION}}` | Where the VPS runs | `Hetzner Online GmbH` / `Falkenstein, Germany` | |
| `{{SMTP_PROVIDER}}` | Outbound e-mail provider (or "self-hosted mail server") | `Brevo` | |
| `{{EU_REPRESENTATIVE}}` | GDPR Art. 27 EU representative — **only if you target EU users from outside the EU** (delete the line otherwise) | | |
| `{{UK_REPRESENTATIVE}}` | UK GDPR Art. 27 representative — same test | | |
| `{{SCC_GOVERNING_LAW}}` | EU Member State whose law governs the SCCs (Clause 17); must be a state that allows third-party-beneficiary rights | `Ireland` | |

## Things only the owner can decide (open legal questions)

1. **Which entity is the contracting party?** A sole proprietor, a (Pty) Ltd, or a foreign entity changes the Terms' liability/indemnity wording and POPIA's definition of "responsible party".
2. **Register the Information Officer.** POPIA s.55/s.56 and the Information Regulator's registration portal (eServices at inforegulator.org.za) — registration is required for private bodies; see the access-dated sources below. Check the current guidance for deputy information officers.
3. **EU/UK establishment.** If you knowingly offer the service to people in the EU/UK without an establishment there, GDPR Art. 27 / UK GDPR Art. 27 may require a representative. If you are not targeting them, state that and remove the line.
4. **Cross-border transfers out of South Africa (POPIA s.72).** The documents rely on s.72(1)(a) (binding agreement / recipient law providing adequate protection) and on the contracts with the hosting provider. Confirm with counsel for your chosen host's country.
5. **Liability cap, indemnities, SLA.** The Terms use a conservative "12 months' fees (or ZAR 1 000 if free)" cap and **no uptime SLA**. Both are business decisions and must be tested against the South African **Consumer Protection Act** (unfair-term and plain-language rules) and **ECTA** (electronic transactions) when selling to consumers/small businesses. B2B-only positioning makes this easier.
6. **Minimum age.** The Terms say 18+ (B2B). If minors might register, POPIA s.35 and GDPR Art. 8 rules apply and the product would need parental-consent flows it does not have.
7. **Governing law of the SCCs** (`{{SCC_GOVERNING_LAW}}`) and whether to name an EU Member State other than Ireland.
8. **Free-tier promises.** The documents promise the data-subject features that now exist in the product (export, account erasure, org erasure). They deliberately do **not** promise a specific uptime, support response time or breach-notification SLA to customers beyond "without undue delay" and the statutory 72 h.
9. **Marketing e-mail.** None is sent. If you add it, you need opt-in consent (POPIA s.69, ePrivacy / PECR) and an unsubscribe; update the Privacy Policy and Cookie Policy first.
10. **Tax / accounting retention.** The Privacy Policy states 5 years for invoices (typical South African Tax Administration Act s.29 / Companies Act s.24 period). Have your accountant confirm.

## What the product does to support these documents (as implemented)

| Promise in the documents | Where it lives |
|---|---|
| Export my data (Art. 15 / 20, POPIA s.23) | `GET /api/v1/privacy/export`; Settings → Privacy |
| Export my organisation's data | `GET /api/v1/privacy/org-export` (owner/admin) |
| Erase my account (Art. 17, POPIA s.24) | `DELETE /api/v1/privacy/account` (password re-auth) |
| Erase my organisation | `DELETE /api/v1/privacy/org` (owner, password, type the org name) |
| Proof of acceptance of Terms / Privacy Policy | `users.accepted_terms_at`, `users.terms_version` (registration checkbox) |
| Audit trail of exports/erasures, without PII | `audit_logs` actions `privacy.user_export`, `privacy.org_export`, `privacy.account_deleted`, `privacy.org_deleted` |
| Notice at the point of collection (widget) | text under the e-mail field in `widget/src/index.ts` |

### Known gaps (be honest in any questionnaire)

* Deleting a **single annotation or project** removes database rows but **not** the screenshot object (the `ScreenshotStore` port has no delete; only account/org erasure removes objects). Orphaned objects can be found by comparing the bucket/volume with `annotations.screenshot_object_key`.
* There is **no automatic purge** of expired auth-token rows, the notification outbox, webhook delivery logs, portal sessions or audit logs. They are removed when the account/org is erased; the retention periods in [DATA_RETENTION.md](./DATA_RETENTION.md) for these are targets, labelled as such.
* **Backups** are not rewritten when data is erased. After restoring a backup you must re-apply erasures (the `privacy.account_deleted` / `privacy.org_deleted` audit events list the ids to re-erase) — see [DATA_RETENTION.md](./DATA_RETENTION.md).
* Erasing an account **deletes API keys that account created** (they run as their creator). Automation using them stops working.
* The privacy routes use a per-instance in-memory throttle for failed password confirmations (5 / 15 min / user); behind several API instances the effective limit is per instance.
* Pre-existing accounts have no `accepted_terms_at` (we do not invent consent). Ask existing users to re-accept on next login if your lawyer requires it.

## Sources (accessed 2026-11-27)

Pages marked ✔ were retrieved and read on the access date; pages marked ✖ blocked automated access (HTTP 403) and were **not** verified — check them manually.

* ✔ Regulation (EU) 2016/679 (GDPR), Art. 13, 14, 15, 16, 17, 18, 20, 21, 28, 30, 32, 33, 34 — consolidated text, e.g. <https://gdpr-info.eu/art-28-gdpr/> (unofficial mirror; the authoritative text is on EUR-Lex).
* ✔ Commission Implementing Decision (EU) 2021/914 of 4 June 2021 on standard contractual clauses for the transfer of personal data to third countries — <https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj> (reachable; the page is a JavaScript-rendered document — verify clause numbers in the official PDF) and the Commission's SCC overview <https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/standard-contractual-clauses-scc_en>.
* ✖ UK GDPR / Data Protection Act 2018 and the ICO's International Data Transfer Agreement and **Addendum to the EU SCCs** (in force 21 March 2022) — <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/international-data-transfer-agreement-and-guidance/> (HTTP 403 to our fetcher; verify manually).
* ✖ ICO guidance on cookies and similar technologies (PECR reg. 6, "strictly necessary" exemption) — <https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/> (403; verify manually).
* ✖ Article 29 Working Party Opinion 04/2012 on Cookie Consent Exemption (WP 194) — cited from the authors' knowledge, **not fetched**; verify against the EDPB archive.
* ✔ EDPB Guidelines 05/2020 on consent — <https://edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en>; Directive 2002/58/EC (ePrivacy) Art. 5(3) for the "strictly necessary" exemption.
* ✔ Protection of Personal Information Act 4 of 2013 (POPIA): s.18 (notification to data subject), s.19–21 (security, operators), s.22 (security compromises), s.23–24 (access, correction/deletion), s.55–56 (information officers), s.72 (transborder flows) — <https://popia.co.za/> (section pages read on the access date; the Act's authoritative text is the Government Gazette).
* ✔ Information Regulator (South Africa) — <https://inforegulator.org.za/> and <https://inforegulator.org.za/contact-us/>: general enquiries `enquiries@inforegulator.org.za`, complaints `POPIAComplaints@inforegulator.org.za`, 54 Maxwell Drive, Woodmead, Johannesburg, 2191, tel. 010 023 5200 (as shown on the site on the access date).
* ✔ California Consumer Privacy Act as amended by the CPRA — California Attorney General overview <https://oag.ca.gov/privacy/ccpa>; statute Cal. Civ. Code §1798.100 et seq. (service-provider contract terms: §1798.100(d), §1798.140(ag)).
* Internal: [`docs/SECURITY_REVIEW.md`](../SECURITY_REVIEW.md), [`docs/compliance/`](../compliance/README.md), [`docs/SOC2_READINESS.md`](../SOC2_READINESS.md) — the technical controls the documents point at. SOC 2 materials are a gap assessment, **not** a compliance claim.
