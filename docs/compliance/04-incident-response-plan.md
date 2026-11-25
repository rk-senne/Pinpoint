# 04 — Incident Response Plan

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner = incident commander>` | `<management>` | Annual + tabletop exercise twice a year | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim. **Not legal advice** — have counsel confirm notification duties.

## 1. Definitions
An **incident** is any event that compromises, or credibly threatens, confidentiality, integrity or availability of the
service or customer data (e.g. leaked secret, cross-tenant data exposure, unauthorised access, ransomware, prolonged outage).

## 2. Severity matrix

| Sev | Definition (examples) | Response start | Update cadence | Who |
|---|---|---|---|---|
| **SEV1** | Confirmed/likely customer-data exposure or cross-tenant access; production credentials compromised; full outage > 30 min | Immediately (≤ 15 min) | every 30 min | Commander + all engineers + management |
| **SEV2** | Partial outage or degraded core flow (login, submit feedback, screenshots); vulnerability being actively exploited without confirmed data loss | ≤ 1 h | every 2 h | Commander + on-call engineer |
| **SEV3** | Contained issue, no customer data impact (single failed deploy, non-exploited vulnerability report, suspicious login pattern) | ≤ 1 working day | daily | On-call engineer |
| **SEV4** | Minor / informational | Next sprint | — | Ticket |

## 3. Contacts (fill in; keep a printed/offline copy)

| Role | Name | Phone/Signal | Backup |
|---|---|---|---|
| Incident commander | `<>` | `<>` | `<>` |
| Engineering on-call | `<>` | `<>` | `<>` |
| Management / comms | `<>` | `<>` | `<>` |
| Legal counsel | `<>` | `<>` | — |
| Hosting provider support | `<URL / ticket>` | — | — |
| Security reports inbox | `security@<domain>` (publish a `SECURITY.md`) | — | — |

## 4. Procedure
1. **Detect/report** — sources: monitoring alerts ([09](09-logging-monitoring-policy.md)), customer report, vulnerability disclosure, staff. Anyone can declare an incident; open an incident record `<tracker>` with time, reporter, summary.
2. **Triage** — commander assigns a severity (above) and a scribe. Keep a timestamped log of facts and actions.
3. **Contain** (prefer reversible actions; preserve evidence first):
   - Credential leak: rotate the secret (`JWT_SECRET` signs everyone out; DB/SMTP/API keys; `INTEGRATION_ENCRYPTION_KEY` needs a re-encryption plan), revoke GitHub/hosting tokens, review the audit log (`GET /api/v1/org/audit-log`).
   - Compromised user/session: `POST` revoke-sessions (bumps `token_version`, disconnects sockets), revoke the user's API keys.
   - Cross-tenant bug: disable the affected route/feature or take the API offline; RLS limits blast radius but is not a substitute.
   - Host compromise: snapshot the disk (provider snapshot) **before** rebuild, isolate via firewall, rebuild from `deploy/install.sh` and restore from backup ([05](05-business-continuity-backup-dr.md)).
4. **Preserve evidence:** copy API logs (`docker compose logs api`, request ids), `audit_logs` rows, host auth logs, the provider snapshot, to a restricted location. Do not rely on Docker's default log rotation.
5. **Eradicate and recover:** fix root cause via the emergency change path ([03 §4](03-change-management-policy.md)), restore service, verify with `/health` and a smoke test.
6. **Communicate:** internal updates per the cadence above; customers per §5.
7. **Post-incident review** within 5 working days (blameless): timeline, root cause, what worked, actions with owners/dates, risk-register update ([11](11-risk-assessment-and-register.md)). Store with the incident record.

## 5. Breach notification (note — confirm with counsel)
- **GDPR:** if personal data of EU/UK residents is breached, the controller must notify the supervisory authority without undue delay and, where feasible, within **72 hours** of becoming aware, unless unlikely to risk individuals' rights; processors must notify the controller without undue delay. For customers who self-host Pinpoint, the customer is the controller and operator.
- **Contracts/DPAs:** check each customer agreement for its own deadline (often 24–72 h) and who must be told.
- **Other jurisdictions** (US state laws, etc.): `<counsel to list>`.
- Notification content: what happened, data/tenants affected, time window, actions taken, what customers should do, contact.
- Never include secrets or other tenants' data in notifications.

## 6. Exercises and metrics
Tabletop twice a year using a realistic scenario (e.g. "leaked `.env.production`", "tenant data visible to another tenant").
Track time to detect/contain/recover per incident.

## 7. Sign-off
Approved by `<name>` on `<date>`.
