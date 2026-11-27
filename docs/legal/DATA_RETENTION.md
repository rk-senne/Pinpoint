# Data Retention

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** This page maps every data set to **what the software actually does today**. Where a period is a *target* (no automatic job enforces it yet) it is marked **target**. Do not publish a "target" as a guarantee until the corresponding job exists. Have a lawyer and your accountant review the legal-retention rows.

Legal basis for limiting retention: GDPR Art. 5(1)(e) storage limitation, POPIA s.14 (retention and restriction of records), CCPA §1798.100(a)(3).

## 1. Retention table (hosted service)

| Data | Where | Retention (what happens today) | Deleted by |
|---|---|---|---|
| **User account**: name, e-mail, avatar URL, bcrypt hash, preferences, terms acceptance | `users` | Until the user deletes the account | *Settings → Privacy → Delete account* (`DELETE /api/v1/privacy/account`): row, memberships, team memberships, sessions, one-time tokens, social-sign-in links, in-app notifications and queued e-mails are deleted |
| **Social sign-in link** | `oauth_accounts` | With the account | Account deletion |
| **Sessions** | stateless JWT (24 h) + cookie `Max-Age` 24 h; refreshable up to a 7-day grace after expiry | Expire automatically; revoked at logout, password change, role/membership change and account deletion (`token_version`) | Automatic |
| **E-mail verification / password-reset tokens** | `auth_tokens` (hash only) | Valid 24 h / 1 h. **Expired rows are not purged automatically** (target: purge after 30 days) | Account deletion; target job |
| **Organisation, projects, pages, annotations, comments, tags, boards, portals, rules, SLA policies, integrations, webhooks** | PostgreSQL | Until the customer deletes them or the organisation | Customer deletes items; *Delete organisation* (`DELETE /api/v1/privacy/org`) removes the whole organisation by cascading foreign keys in one transaction |
| **Content authored by an erased user** | `annotations`, `comments`, `activity_events`, `satisfaction_scores` | **Kept for the organisation** (processor-retained record), author replaced by "Deleted user"; guest name/e-mail matching the user's address removed | Organisation deletes it; organisation deletion |
| **Screenshots, markup documents** | local volume `LOCAL_STORAGE_DIR` or S3-compatible bucket | Life of the annotation. Removed by **organisation deletion and by account deletion when the user's sole-member organisation is deleted**. Deleting a *single* annotation/project does **not** yet delete its object (known gap) | Organisation / account erasure; operator reconciliation of orphans |
| **Console logs, JS errors, network captures, session-replay buffers** | `annotations` JSON columns | Same as the annotation (high sensitivity — **target**: customers should delete or the operator cap at 90 days; not enforced) | With the annotation |
| **Guest feedback (name, e-mail)** | `annotations`, `board_posts`, `board_votes`, `portal_sessions` | Same as the annotation/board | With the item; erasure of a user removes rows matching their e-mail |
| **Portal magic-link sessions** | `portal_sessions` | Token valid 24 h; **row not purged automatically** (target: 30 days) | Organisation deletion; target job |
| **Audit log** | `audit_logs` (append-only) | Kept while the organisation exists; target ≥ 12 months for evidence. When a user is erased the IP address, user-agent and actor link on events they performed are **removed** (the event itself stays). Organisation deletion deletes its log. Events `privacy.account_deleted` / `privacy.org_deleted` are kept **without an organisation and without personal data** | Organisation deletion; user erasure (scrub) |
| **Notification outbox** (queued/sent e-mails) | `notifications` | **Not purged automatically** (target: 90 days after `sent`/`failed`). Rows addressed to an erased user are deleted | Account erasure; target job |
| **Webhook delivery log** | `webhook_deliveries` | With the endpoint/organisation; **no automatic purge** (target: 30 days) | Endpoint/organisation deletion |
| **Application logs** | container logs on the host | Operator-configured Docker log driver (default has **no cap**); target 30–90 days. Request logs hold request id, method, path, status, timing; secrets/headers are redacted | Operator rotation |
| **Reverse-proxy access logs** | Caddy | Operator-configured; may contain IP addresses; target ≤ 30 days | Operator rotation |
| **Metrics** | Prometheus | 15 days (default `PROMETHEUS_RETENTION=15d`); no personal data (route patterns, not raw URLs) | Automatic |
| **Backups** | `BACKUP_DIR` and any off-host copy | **14 days by default** (`BACKUP_RETENTION_DAYS`, allowed range 14–35 in our policy). Contain data deleted since the backup was taken until they expire | Automatic roll-off (`deploy/backup.sh`) |
| **Billing / invoice records** | Stripe and the accounting system | **5 years** after the financial year (typical South African tax and company-law period — *accountant to confirm*) | After the legal period |
| **Support e-mails** | mailbox | Up to 24 months after the ticket closes (**target**) | Manual |
| **Terms-acceptance record** | `users.accepted_terms_at`, `terms_version` | With the account (evidence of the contract) | Account deletion |

## 2. Erasure requests and backups

* **Self-service** erasure is immediate in the live database. It is **not** rewritten into existing backups, which age out within the backup window above. Backups are encrypted/access-restricted and are **not used to restore individual records**.
* **After a restore** from a backup the operator **must re-apply erasures** that happened since the backup date. The audit events `privacy.account_deleted` (resource id = the erased user id) and `privacy.org_deleted` (resource id = the organisation id) are written outside any organisation precisely so the list survives; re-run the erasures for those ids before reopening the service. Record this in the restore checklist (`deploy/restore.sh`, `docs/compliance/05-business-continuity-backup-dr.md`).
* **Legal holds:** the operator may retain data needed to establish, exercise or defend legal claims or to comply with law, restricted to that purpose.

## 3. Export size limits

`GET /api/v1/privacy/export` is capped at **50 MB** and `GET /api/v1/privacy/org-export` at **250 MB**. If a cap is reached the JSON ends with `"truncated": true` and omits later items (largest sections — annotations with captures — are streamed last). Ask {{CONTACT_EMAIL}} for an offline export; we will provide it within the statutory period.

## 4. Self-hosted deployments

The organisation operating the deployment decides retention. The same erasure and export endpoints exist; configure log rotation, backup retention and any purge jobs to match your own policy.

## 5. Related

[Privacy Policy](./PRIVACY_POLICY.md) · [Breach Response](./BREACH_RESPONSE.md) · internal draft policy: [`docs/compliance/07-data-retention-deletion-policy.md`](../compliance/07-data-retention-deletion-policy.md).
