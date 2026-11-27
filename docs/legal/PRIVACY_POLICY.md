# Privacy Policy

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** This policy was drafted from how Pinpoint actually handles data and must be reviewed by a lawyer before it is relied on. See the legal pack README.

This policy explains what personal information **{{COMPANY_NAME}}** ("**we**", "**us**", registration no. {{COMPANY_REG_NO}}, {{COMPANY_ADDRESS}}) processes when you use the hosted Pinpoint service at {{SERVICE_URL}}, the Pinpoint browser extension and the Pinpoint feedback widget (together, the "**Service**"). It is written to meet the notice duties in the EU/UK GDPR (Art. 13 and 14), South Africa's Protection of Personal Information Act ("**POPIA**", s.18) and the California Consumer Privacy Act as amended ("**CCPA/CPRA**").

If you run Pinpoint **on your own infrastructure**, you are the controller / responsible party for that deployment and this policy does not apply to it (see [Self-hosting](#self-hosted-deployments)).

## 1. Who is responsible — and in which role

Pinpoint is used by teams (an "**organisation**" or "**customer**") to collect feedback on websites. We act in two different roles:

| Data | Our role | Who decides why it is processed |
|---|---|---|
| **Account and service data**: your login, profile, billing, security and usage records | **Controller** (POPIA: *responsible party*) | We do |
| **Customer content**: annotations, comments, screenshots, console/network captures, session-replay snippets, guest feedback, portal and board entries, integration data that your organisation collects or stores in Pinpoint | **Processor** (POPIA: *operator*) acting on the customer's instructions; the **customer** is the controller / responsible party | Your organisation |

For customer content, the [Data Processing Agreement](./DATA_PROCESSING_AGREEMENT.md) governs our handling. If you are a reviewer, guest or client who gave feedback through a customer's link, widget, portal or extension, **the organisation that invited you is the party to ask first** about your data; we will help it respond.

**Contact:** {{CONTACT_EMAIL}} · **Information Officer (POPIA):** {{INFORMATION_OFFICER}}, {{INFORMATION_OFFICER_EMAIL}}.

## 2. What we collect

### 2.1 Account and service data (we are the controller)

| Category | Examples | Source |
|---|---|---|
| Identity & contact | name, e-mail address, avatar URL (optional) | You; or Google/GitHub if you use social sign-in (provider id, e-mail, name, avatar) |
| Credentials | password stored only as a salted **bcrypt hash**; session tokens | You / generated |
| Organisation data | organisation name and slug, your role (owner, admin, member, viewer), invitations (invitee e-mail), teams | You / your organisation |
| Terms acceptance | time and version of the Terms and Privacy Policy you accepted at registration | Generated |
| Preferences | notification settings, theme (stored in your browser) | You |
| Billing (only if you pay) | plan, Stripe customer and subscription ids, invoice records. **Card details are collected and held by Stripe, never by us.** | You / Stripe |
| Security & audit records | audit-log entries (who did what, when, to which resource), your **IP address**, browser user-agent and a request id for security-relevant actions such as sign-in, password reset, API-key creation, exports | Generated automatically |
| Operational logs | request id, method, path, status code and timing of API requests; the web server may also log IP addresses | Generated automatically |
| Transactional e-mail | verification, password-reset, invitation and notification e-mails, and the queue record of each (recipient address and content) | Generated |
| Support | what you send us when you write to {{CONTACT_EMAIL}} | You |

### 2.2 Customer content (we are the processor)

When someone annotates a page with Pinpoint, the organisation's project may store:

* the annotation text, severity, type, status, assignee and due date; comments and @mentions;
* the **page URL**, a DOM selector for the annotated element and a text snippet of it;
* **environment metadata**: browser, version, operating system, viewport size, device pixel ratio, user-agent string;
* optionally, if the reviewer enables each capture: a **screenshot** (stored in object storage; it can show anything on the reviewed page, including personal data, and an organisation can mark regions for redaction), **console log entries and JavaScript errors**, **network request summaries** and a short **session-replay** buffer of page interactions. Password fields and elements marked `data-fl-redact` / `data-fl-private` are masked before capture and diagnostic text is scrubbed of obvious secrets, but **scrubbing is best-effort**: reviewers and organisations must not capture pages showing data they have no right to share;
* **guest feedback** (shared links, widget, client portals, public boards): the message, and — only if the guest provides them — a name and e-mail address; board votes use the voter's e-mail or a derived voter key; portal access creates a session record with the e-mail and a one-time magic-link token (valid 24 hours);
* satisfaction (CSAT) ratings and comments;
* integration connections your organisation sets up (Slack, Jira, Linear, GitHub, ClickUp, Asana): OAuth tokens (**encrypted at rest with AES-256-GCM**), configuration and the external ids of items sent; webhook endpoints (URL, encrypted signing secret) and their delivery log.

We do **not** knowingly collect special-category / special personal information, children's data, or payment-card numbers. Do not put them into Pinpoint.

### 2.3 Cookies and similar technologies

Only strictly necessary cookies are used — see the [Cookie Policy](./COOKIE_POLICY.md). We use **no analytics, advertising or tracking** cookies or scripts, and the widget sets no cookies and uses no browser storage. The browser extension stores your sign-in token, the server URL and per-site capture preferences in the browser's extension storage.

## 3. Why we use it, and the legal basis

| Purpose | Data | GDPR basis (Art. 6) | POPIA justification (s.11) |
|---|---|---|---|
| Create and run your account, authenticate you, provide the Service | account data | Contract (6(1)(b)) | Necessary to perform a contract |
| Process customer content for the customer | customer content | As processor: customer's instructions (Art. 28) | Operator under written contract (s.20–21) |
| Send service e-mails (verification, resets, invitations, notifications you enabled) | name, e-mail, content | Contract | Contract |
| Security, abuse prevention, fraud detection, audit trail, rate limiting | IP, user-agent, audit records, logs | Legitimate interests (6(1)(f)): keeping the Service and customers' data safe | Legitimate interest of the responsible party |
| Billing, tax and accounting | billing data | Contract; legal obligation (6(1)(c)) | Contract; legal obligation |
| Prove acceptance of our Terms / respond to legal claims | acceptance record, relevant records | Legitimate interests; legal obligation | Legitimate interest; legal obligation |
| Improve reliability | aggregated metrics (no personal data) | Legitimate interests | Legitimate interest |

We do not sell your personal information, do not "share" it for cross-context behavioural advertising, do not profile you, and do **not** make decisions about you based solely on automated processing (GDPR Art. 22). Feedback "triage" suggestions are rule-based hints shown to a human; they do not leave our servers. Providing account data is required to use the Service; providing optional diagnostics, avatars and guest names/e-mails is voluntary.

## 4. Who we share it with

* **Your organisation's other members**, according to their role in that organisation (e.g. admins see members' names and e-mails and the organisation's audit log).
* **Sub-processors** we use to run the Service — listed in [Sub-processors](./SUBPROCESSORS.md) (hosting, outbound e-mail and, only if enabled, object storage, payments and social sign-in). They may only process on our instructions.
* **Recipients your organisation chooses**: when an organisation connects an integration or webhook, feedback is sent to that third party at the organisation's request; that recipient's own terms and privacy policy apply.
* **Authorities and advisers** when the law requires it, or to establish, exercise or defend legal claims; and a successor if we are merged or sold (with the same protections).

## 5. Transfers outside your country

Our hosting is located in {{HOSTING_REGION}} ({{HOSTING_PROVIDER}}). We operate from South Africa. When personal information moves across borders we rely on:

* **EU/EEA → South Africa (or other non-adequate countries):** the European Commission's **Standard Contractual Clauses** (Implementing Decision (EU) 2021/914) — Module Two (controller → processor) and Module Three (processor → sub-processor), incorporated in the [Data Processing Agreement](./DATA_PROCESSING_AGREEMENT.md) — plus the **UK Addendum** issued by the ICO for UK transfers.
* **South Africa → other countries (POPIA s.72):** the recipient being bound by a law or binding agreement that provides substantially similar protection, or your consent / contract necessity where applicable.
* **Adequacy decisions** where they exist (e.g. the EU–US Data Privacy Framework for certified US providers).

You can ask us for a copy of the safeguards (contact above).

## 6. How long we keep it

See [Data Retention](./DATA_RETENTION.md) for the full table. In short: account data until you delete the account; customer content until the customer deletes it or the organisation; audit records while the organisation exists (personal fields are removed when an account is erased); invoices for 5 years; backups roll off within 14–35 days.

**When you delete your account** we delete your profile, credentials, memberships, sessions and notifications. **Content you authored inside an organisation that continues to exist (annotations, comments, activity records) is not deleted** — it belongs to that organisation's project history and we keep it **as the organisation's processor-retained record**, but we **detach it from you**: the author becomes "Deleted user" and personal fields in audit records (IP address, browser string, actor link) are removed. If you want specific content removed, ask the organisation's admins (or us, and we will pass the request on). Organisations that contain only you are deleted with the account, including their screenshots. Erased data can remain in encrypted backups until they expire (see above) and is not restored into production.

## 7. Your rights

Depending on where you live you have some or all of these rights:

| Right | GDPR / UK GDPR | POPIA | CCPA/CPRA | How to use it in Pinpoint |
|---|---|---|---|---|
| Be informed | Art. 13–14 | s.18 | notice at collection | This policy |
| Access / know / copy | Art. 15, 20 | s.23 | right to know | **Settings → Privacy → Export my data** (`GET /api/v1/privacy/export`); organisation admins can also **Export organisation data** |
| Correct | Art. 16 | s.24 | right to correct | **Settings → Profile**; or write to us |
| Delete / erase | Art. 17 | s.24 | right to delete | **Settings → Privacy → Delete account** (or delete organisation) |
| Restrict / object | Art. 18, 21 | s.11(3) | limit/opt-out | Write to us; we do not use your data for direct marketing or profiling |
| Withdraw consent | Art. 7(3) | s.11 | — | Where processing is based on consent (e.g. optional social sign-in link) remove the link / write to us |
| Not to be subject to automated decisions | Art. 22 | s.71 | — | None are made |
| Complain | your supervisory authority | Information Regulator | California AG / CPPA | See §10 |
| Non-discrimination | — | — | yes | We do not treat you differently for exercising rights |

We respond within **30 days** (GDPR; one month), "reasonable time" (POPIA) and 45 days (CCPA), and may need to verify your identity first. If your data is customer content held for an organisation, we will refer you to that organisation or forward the request, because it decides what happens to its records. Exercising rights is free unless a request is manifestly unfounded or excessive (POPIA permits a prescribed fee for some access requests).

## 8. Security

We protect personal information with measures including TLS on all external traffic, bcrypt-hashed passwords, HttpOnly/Secure/SameSite session cookies with CSRF protection, per-organisation data isolation enforced in application code **and** by PostgreSQL row-level security, role-based access control, encrypted integration secrets, an append-only audit log, request rate limits, SSRF-guarded outbound requests and regular backups. Details are in the [Data Processing Agreement, Annex II](./DATA_PROCESSING_AGREEMENT.md#annex-ii-technical-and-organisational-measures). No system is perfectly secure; if a breach affects you we will notify you and the regulator as the law requires (see [Breach Response](./BREACH_RESPONSE.md)).

## 9. Children

The Service is for businesses and is not directed at people under 18. We do not knowingly collect children's information; contact us if you believe we have, and we will delete it.

## 10. Complaints and regulators

Please contact us first at {{CONTACT_EMAIL}} — we want to fix it. You may also complain to:

* **South Africa — Information Regulator:** POPIAComplaints@inforegulator.org.za (complaints), enquiries@inforegulator.org.za, 54 Maxwell Drive, Woodmead, Johannesburg, 2191, tel. 010 023 5200, <https://inforegulator.org.za>.
* **EU/EEA** — the supervisory authority where you live, work or where the issue occurred.
* **UK** — the Information Commissioner's Office, <https://ico.org.uk>.
* **California** — the California Attorney General and the California Privacy Protection Agency.

## 11. Specific notes by region

* **EU/UK:** controller is {{COMPANY_NAME}}; EU representative: {{EU_REPRESENTATIVE}}; UK representative: {{UK_REPRESENTATIVE}} *(delete if not required)*.
* **South Africa:** the responsible party is {{COMPANY_NAME}}; Information Officer {{INFORMATION_OFFICER}} (registered with the Information Regulator).
* **California:** in the last 12 months we have **not sold or shared** personal information and have not disclosed it for a business purpose other than to our service providers listed in [Sub-processors](./SUBPROCESSORS.md). Categories collected: identifiers, internet/network activity (diagnostics you enable), and professional/commercial information (organisation, role, plan); we draw no inferences. We do not collect sensitive personal information as defined by the CPRA.

## Self-hosted deployments

Pinpoint is open software that organisations can run themselves. For a self-hosted deployment the organisation running it — not {{COMPANY_NAME}} — is the controller / responsible party and must publish its own notices; {{COMPANY_NAME}} receives no data from it. This policy and the other documents in `docs/legal/` are provided as editable templates for that purpose.

## 12. Changes

We will post changes here with a new "last updated" date and, for material changes, notify account owners by e-mail before they take effect. The version you accepted at registration is recorded against your account.
