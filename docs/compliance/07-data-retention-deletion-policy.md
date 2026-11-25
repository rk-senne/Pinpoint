# 07 — Data Retention & Deletion Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security/privacy owner>` | `<management>` | Annual | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim. Retention periods below are **proposals to
decide**, with legal/contractual input; they are not implemented defaults unless stated.

## 1. Data inventory and classification

| Data | Class | Where | Proposed retention |
|---|---|---|---|
| Annotations, comments, assignments | Customer confidential | Postgres | Life of the customer's project/org + `<30>` days after deletion |
| Screenshots, markup | Customer confidential (may show sensitive page content) | Local volume or S3 bucket | Same as the annotation |
| Session replay / console / network captures | Customer confidential (high sensitivity) | Postgres | Same as annotation; consider a shorter cap `<90 days>` (not implemented) |
| Guest e-mail addresses (widget/boards/portals) | Personal data | Postgres | Same as annotation; deletable on request |
| User accounts, org memberships | Personal data | Postgres | Life of the account + `<30>` days |
| Audit log | Internal / evidence | Postgres `audit_logs` (append-only) | ≥ 12 months (SOC 2 Type II needs it); ship off-host |
| Application logs | Internal (may contain request metadata; secrets redacted) | Docker logs | `<30–90>` days; configure the log driver (default has no cap) |
| Backups | Customer confidential | `BACKUP_DIR` + off-box | 14–35 days (`BACKUP_RETENTION_DAYS`); deleted data persists in backups until expiry |
| Notification outbox | Internal | `notifications` table | Sent/failed rows `<90>` days (not implemented) |
| Secrets/env file | Restricted | Host, password manager | Rotate per [02](02-access-control-policy.md) |

## 2. Deletion — what the system does today (verified from docs/code review; re-verify before relying on it)
- Deleting a **project** cascades to its pages, annotations, comments, shared links (FKs `ON DELETE CASCADE`).
- Org-scoped tables carry an FK to `organizations ON DELETE CASCADE` (PP-10 fix), so deleting an organisation row removes its data in the database. **There is no "delete organisation" API/UI yet** — org deletion is a manual, privileged DB operation (risk R-10).
- Screenshots on the **local** driver or S3: deletion of the underlying file when an annotation/project is deleted is **not verified** (`SOC2_READINESS.md` CC6.5). Treat orphaned files as a gap: periodically reconcile `LOCAL_STORAGE_DIR` / the bucket against `annotations`.
- User deletion/erasure: no self-service flow; handled as a request (§3).
- Backups are not rewritten; deleted data ages out with the retention window.

## 3. Deletion / export requests (customers and data subjects)
1. Verify the requester (account owner or authenticated contact) and log the request `<tracker>`.
2. Respond within **30 days** (GDPR) or the contractual period.
3. Export: org admin can export projects (`POST /api/v1/projects/:id/export`, CSV/PDF).
4. Erasure: a named engineer deletes the rows (project/org cascade, user row, guest e-mails), removes screenshot objects, revokes integration tokens, and records the action. State in the reply that backups expire within `<N>` days.
5. Record completion date and approver.

## 4. Self-hosted customers
They are the controller and operator; this policy covers only the service `<Company>` operates.

## 5. Offboarding a customer
Export on request → disable accounts → delete the org (§3) → confirm in writing; remove from monitoring and vendor sharing.

## 6. Sign-off
Approved by `<name>` on `<date>`.
