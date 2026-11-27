# 09 — Logging & Monitoring Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<engineering lead>` | `<security owner>` | Annual; alert rules reviewed quarterly | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. What is logged today (design evidence)
| Source | Content | Notes |
|---|---|---|
| API application log | `pino` JSON: request id (UUID, `X-Request-Id`), method, path, status, latency; errors; secrets redacted | Docker log driver default has **no size/age cap** — configure (§3) |
| Audit log (`audit_logs`, `GET /api/v1/org/audit-log`) | Auth events (login success/fail, logout, resets, e-mail change, session revocation, org switch), exports, share links, portals, boards, integrations, webhooks, invitations, team changes, API keys, member changes, org settings, project deletion; with IP, user agent, request id | Append-only via DB trigger; a DB superuser can disable it. **Not audited:** logins rejected by the rate limiter (429), board update/delete, workflow-rule and SLA mutations |
| Metrics (`/metrics`, token-gated) | `http_requests_total`, `http_request_duration_seconds`, Node process metrics | Prometheus via the `monitoring` profile (`deploy/prometheus.prod.yml`) |
| Health | `/health`, `/health/ready`, `/health/live` | Used by Docker healthchecks |
| Host | SSH/auth logs (journald/auth.log), `ufw` | Not shipped anywhere by default |
| Backups | `/var/log/pinpoint-backup.log` | Alert on staleness ([05](05-business-continuity-backup-dr.md)) |

## 2. Requirements
1. Keep application logs ≥ `<90 days>` hot and audit-log/host-auth evidence ≥ **12 months** (SOC 2 Type II period). Ship them to storage separate from the app host (object storage with versioning/lock, or a log service) — `<mechanism>`.
2. Logs must not contain secrets, passwords, tokens or full request bodies; reviewers reject changes that log them.
3. Clocks synchronised (NTP/`systemd-timesyncd`).
4. Access to logs follows [02](02-access-control-policy.md); logs are not editable by the people they record.

## 3. Minimum configuration
- Docker log rotation, in `/etc/docker/daemon.json`: `{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"10"}}` (then restart Docker/recreate containers).
- Uptime check on `https://<domain>/api/v1/health` from an external monitor `<service>` with e-mail/phone alerts.
- Prometheus scrape of `api:3001` (`monitoring` profile) if you want latency/error graphs.

## 4. Alerts (define, route to the on-call, record each firing)
| Signal | Threshold (initial) | Action |
|---|---|---|
| Health check failing | 2 consecutive failures | SEV2 triage ([04](04-incident-response-plan.md)) |
| 5xx rate | > 2 % for 5 min | Investigate |
| Backup stale / failed | > 26 h | Fix before next window |
| Disk usage | > 80 % | Resize/prune |
| Failed-login burst (`auth.login_failed` per IP/org) | > `<20>`/10 min | Review for credential stuffing |
| Privilege change / API-key creation / export spike | any owner/admin role change; `api_key.created`; `export.created` > `<10>`/h | Verify with the actor |
| SSH login from new IP / root | any | Verify |
| Certificate expiry | < 14 days | Check Caddy/ACME |

## 5. Review
Security owner reviews alerts fired and the audit log summary monthly (`<30 min>`), records findings, and updates thresholds
quarterly. Recurring alerts become tickets/risk-register entries.

## 6. Sign-off
Approved by `<name>` on `<date>`.
