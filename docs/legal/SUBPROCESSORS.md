# Sub-processors

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** This list must match what {{COMPANY_NAME}} actually runs. Fill the "Chosen provider" column from your real deployment and delete rows you do not use before publishing.

A **sub-processor** is a third party that {{COMPANY_NAME}} engages to process customer personal data on its behalf to deliver the hosted Pinpoint service (GDPR Art. 28(2) and (4); POPIA operator chain, s.20–21). This list is referenced by the [Data Processing Agreement](./DATA_PROCESSING_AGREEMENT.md). We give customers **30 days' notice** of additions or replacements (§5 below) and flow down data-protection obligations no less protective than the DPA.

## 1. Self-hosted deployments: none

If you run Pinpoint **on your own infrastructure** ({{COMPANY_NAME}} does not host it), **{{COMPANY_NAME}} receives no personal data and has no sub-processors for your deployment.** Your own choices (VPS, mail relay, object storage, Redis) are *your* processors; use the table in §2 as a checklist for your own records of processing (GDPR Art. 30).

## 2. Hosted service — core

Pinpoint's default hosted stack is intentionally small: one virtual server running PostgreSQL, the API, the dashboard and a reverse proxy (see `deploy/docker-compose.prod.yml`). Screenshots default to **local disk on the same server**. The only third parties that necessarily see customer data are therefore the server host and the e-mail provider.

| Sub-processor | Purpose | Data processed | Location | Transfer safeguard | Chosen provider |
|---|---|---|---|---|---|
| **VPS / cloud host** | Runs the application, PostgreSQL database, local screenshot volume, backups on the same host | All customer data and account data (encrypted in transit; at-rest encryption depends on the host's disk encryption) | {{HOSTING_REGION}} | Host's DPA + SCCs where outside EEA/UK; POPIA s.72 agreement | {{HOSTING_PROVIDER}} |
| **Outbound e-mail (SMTP) provider** | Delivers verification, password-reset, invitation and notification e-mails | Recipient name and e-mail address, e-mail content (notification text may quote feedback) | {{HOSTING_REGION}} / provider's region | Provider DPA + SCCs where applicable | {{SMTP_PROVIDER}} (or "self-hosted mail server") |

## 3. Hosted service — optional (only if enabled for the deployment)

| Sub-processor | Enabled when | Purpose | Data processed | Typical location | Safeguard |
|---|---|---|---|---|---|
| **Cloudflare R2 / Backblaze B2 / other S3-compatible storage** | `STORAGE_DRIVER=s3` | Screenshot and markup object storage | Screenshots (may contain personal data), markup JSON | Provider region | Provider DPA + SCCs |
| **Off-site backup storage** | Operator ships `deploy/backup.sh` output off the host | Encrypted copies of database and screenshot backups | All customer and account data (encrypt before upload) | Provider region | Provider DPA + SCCs |
| **Stripe** | `STRIPE_SECRET_KEY` set (paid plans) | Payment processing, subscriptions, invoices | Billing e-mail, name, organisation, plan, card data (held by Stripe as an independent controller for payment) | EU / US | Stripe DPA + SCCs / EU–US DPF |
| **Google / GitHub (sign-in)** | OAuth client ids configured | Social sign-in | Provider id, e-mail, name, avatar; sign-in events | US | Each provider's terms; the user chooses to use it (user-initiated, not a processor for customer content) |
| **GitHub (source hosting, CI)** | Always for the *software* project | Hosts the open-source code and CI | **No customer data.** Not a sub-processor for the Service | US | n/a |
| **Redis (self-managed)** | `REDIS_URL` set | Rate-limit counters, Socket.IO fan-out | Ephemeral counters keyed by IP/organisation id | Same host | Covered by the VPS host |

## 4. Customer-directed recipients (not our sub-processors)

When an organisation connects **Slack, Jira, Linear, GitHub, ClickUp, Asana, a webhook URL or the MCP server/API keys**, feedback is sent to that destination because **the customer instructed it**. These recipients are the customer's own processors/third parties; the customer is responsible for having a suitable agreement with them. We send only to destinations the customer configures, through an egress guard that blocks private/internal addresses.

## 5. Changes to this list

We update this page and notify account owners by e-mail **at least 30 days before** a new or replacement sub-processor starts processing customer personal data. Customers may object on reasonable data-protection grounds within that period by writing to {{CONTACT_EMAIL}}; if we cannot accommodate the objection the customer may terminate the affected service and receive a pro-rata refund of prepaid fees.

## 6. Notes for the owner

* Keep `SUBPROCESSORS.md` equal to reality; GDPR Art. 28(2) requires prior authorisation (general authorisation + this notice mechanism is the usual approach).
* For every provider listed, keep their signed DPA and (if outside the EEA/UK) the SCC module they rely on in your records.
* A provider that only *transports* encrypted data (e.g. your ISP) is not a sub-processor.
