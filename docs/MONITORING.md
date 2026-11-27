# Pinpoint — Monitoring & alerting ($0)

Everything here is open source or a free tier, runs on the same single host as
the app, and costs **$0 recurring**. Prices and limits were read from the
vendors' own pages on **2026-11-27**; re-check them before relying on a limit —
vendors change free tiers.

```bash
# the `dc` shorthand used below (repo root)
dc() { docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production "$@"; }
```

## 1. Architecture

```
                     ┌──────────────── your host ────────────────────────────────────────┐
 Internet ──80/443──▶│ Caddy ──▶ api ──▶ postgres        (only Caddy publishes ports)    │
                     │   ▲        │                                                       │
                     │   │ probes │ /metrics (bearer METRICS_TOKEN)                       │
                     │ blackbox   ▼                                                       │
                     │   └────▶ Prometheus ◀── node-exporter (host + backup textfile)     │
                     │            │   ▲    ◀── postgres-exporter, redis-exporter          │
                     │   rules ──▶│   └── Grafana (127.0.0.1:3000, SSH tunnel)           │
                     │            ▼                                                       │
                     │       Alertmanager ──▶ e-mail (your SMTP) + optional ntfy/Discord/ │
                     │                        Slack/Telegram/webhook                      │
                     └───────────────┬────────────────────────────────────────────────────┘
                                     │ Watchdog ping every 5 min      backup.sh ping
                                     ▼                                       ▼
                    Healthchecks.io (free) — alerts you when the pings STOP  (box dead)
                    UptimeRobot (free)     — checks https://$DOMAIN from outside
```

A monitoring stack on the box cannot tell you the box is down. Two free
external services close that gap (§4): an **external uptime check** and
**Healthchecks.io** (dead-man's switch for the stack itself and for backups).

Enable the stack (config is in `deploy/monitoring/`, nothing to edit):

```bash
PINPOINT_MONITORING=1 sudo deploy/install.sh        # sets COMPOSE_PROFILES + Grafana password; idempotent
# or by hand: set COMPOSE_PROFILES=monitoring in deploy/.env.production, then
dc up -d
```

Reach Grafana through an SSH tunnel (it listens on `127.0.0.1:3000` only):

```bash
ssh -L 3000:127.0.0.1:3000 user@your-host     # then open http://localhost:3000
# login: GRAFANA_ADMIN_USER (admin) / GRAFANA_ADMIN_PASSWORD (default: your METRICS_TOKEN)
```

Prometheus (`9090`) and Alertmanager (`9093`) publish no port at all:
`dc exec prometheus wget -qO- http://localhost:9090/api/v1/alerts`.

## 2. What is monitored

| Signal | Source | Where it is used |
|---|---|---|
| Request rate, 5xx ratio, p50/p95/p99 latency per route | API `/metrics` (`http_requests_total`, `http_request_duration_seconds`) | `ApiHighErrorRate`, `ApiHighLatency`, `ApiNoTraffic`, dashboard |
| API restarts, memory, event loop | API default Node metrics | `ApiRestarting`, dashboard |
| DB reachable from the API | `pinpoint_db_up` (periodic `SELECT 1`, `server/src/infrastructure/metrics.ts`) | `DatabaseUnavailable` |
| Notification / webhook queue depth and age, new permanent failures | `pinpoint_notifications_pending`, `…_oldest_pending_age_seconds`, `pinpoint_notification_failures_total`, `pinpoint_webhook_deliveries_*`, `pinpoint_webhook_delivery_failures_total` (polled every 30 s under the RLS `system` context) | `Notification*`, `Webhook*`, `QueueMetricsStale` |
| Postgres up, connections vs `max_connections`, DB size | `postgres_exporter` (connects as the unprivileged `pinpoint_app`) | `DatabaseUnavailable`, `PostgresConnectionsNearMax` |
| Redis up, clients, memory | `redis_exporter` | `InstanceDown`, dashboard |
| Host CPU, memory, disk | `node_exporter` (host rootfs mounted read-only) | `CpuHigh`, `MemoryHigh`, `DiskSpaceLow` |
| TLS certificate expiry for `$DOMAIN` | `blackbox_exporter` TLS probe of Caddy | `CertificateExpiringSoon` |
| End-to-end health (Caddy → API → DB) | `blackbox_exporter` HTTP probe of `/api/v1/health` | `EdgeProbeFailed` |
| Backup freshness and size | `deploy/backup.sh` writes `pinpoint_backup_last_success_timestamp_seconds` / `pinpoint_backup_last_size_bytes` for node_exporter's textfile collector | `BackupStale`, `BackupNeverRan` |
| The alerting pipeline itself | `Watchdog` → Healthchecks.io; Alertmanager's own counters | `AlertDeliveryFailing` |

Deliberately **not** included: cAdvisor (per-container CPU/memory) — it needs
privileged host mounts and ~100 MB RAM for a 1-host stack where the host
metrics plus `ApiRestarting` already catch the failures that matter; Caddy's
own metrics endpoint — it would need a Caddyfile change, and the blackbox
probes already measure what users see (TLS expiry, health through the edge).

## 3. Alert delivery (free)

| Channel | Setup | Cost / limit |
|---|---|---|
| **E-mail** (always on) | Uses the `SMTP_*` relay the API already uses; recipient `ALERT_EMAIL_TO` (default `ACME_EMAIL`). | $0 beyond whatever SMTP relay you already have (any relay with a free tier, or your own mail server). |
| **ntfy** (phone push) | `ALERT_NTFY_URL=https://ntfy.sh/<long-random-topic>`; install the ntfy app, subscribe to the topic. Alertmanager's JSON is rendered by ntfy's built-in `alertmanager` template (documented at docs.ntfy.sh/publish, read 2026-11-27). | Free, no account; the topic name is the only secret, so make it long and random. Rate limits: see docs.ntfy.sh (not re-verified). Self-hostable. |
| **Discord** | Channel → Edit → Integrations → Webhooks → New Webhook → copy URL → `ALERT_DISCORD_WEBHOOK_URL`. | Free. |
| **Slack** | Create an app with an *Incoming Webhook* → `ALERT_SLACK_WEBHOOK_URL`. | Free workspace is enough. |
| **Telegram** | Create a bot with @BotFather → `ALERT_TELEGRAM_BOT_TOKEN`; message the bot, read your numeric chat id from `https://api.telegram.org/bot<token>/getUpdates` → `ALERT_TELEGRAM_CHAT_ID`. | Free. |
| **Generic webhook** | `ALERT_WEBHOOK_URL` (Alertmanager JSON payload). | — |

Set any subset in `deploy/.env.production`, then `dc up -d alertmanager`.
Secrets (webhook URLs, tokens, SMTP password) are written to 0600 files inside
the container and referenced via `*_file` — they never appear in the config.

Routing (`deploy/monitoring/render-alertmanager.sh`): `severity=critical`
repeats hourly, everything else every 4 h. `severity=info` (only
`ApiNoTraffic`) is **not** notified unless `ALERT_NOTIFY_INFO=true` — a quiet
site is not an outage. If the API is down, its symptom alerts (`Api*`,
`Notification*`, `Webhook*`, `QueueMetricsStale`) are suppressed; likewise
during `DatabaseUnavailable`.

Test your channels end to end any time:

```bash
dc exec alertmanager amtool alert add TestAlert severity=critical \
  --annotation=summary="test" --alertmanager.url=http://localhost:9093
```

## 4. External uptime and heartbeats (free)

### Comparison (limits read 2026-11-27)

| Service | Free tier | Fit |
|---|---|---|
| **UptimeRobot** (uptimerobot.com/pricing) | **Free: $0/month, "personal and commercial projects"**, 50 monitors, 5-minute interval, basic status pages | **Recommended** for the external "is https://$DOMAIN up?" check: most monitors, e-mail/push/webhook alerts. |
| **Healthchecks.io** (healthchecks.io/pricing) | **Hobbyist $0**: 20 jobs (checks), 100 log entries per job | **Recommended** for heartbeats: the Watchdog dead-man's switch and the backup cron. It alerts when a ping is *missing*, which is exactly the "box is dead / cron never ran" case. |
| Better Stack (betterstack.com/pricing) | Free: 10 monitors & heartbeats, 1 status page, Slack & e-mail alerts, 100k exceptions/month | Good alternative, fewer monitors. Check interval on the free plan: see the page (not unambiguous when read). |
| Self-hosted Uptime Kuma | Free software, but needs a **second** always-on host (a free-tier VM elsewhere) | Only worth it if you already have a spare host; otherwise it adds a thing to patch and a second point of failure. |

**Recommendation: one UptimeRobot HTTPS monitor + two Healthchecks.io checks.**

### UptimeRobot — external uptime check (≈ 3 minutes)

1. Sign up at <https://uptimerobot.com> (free plan, no card) and confirm the e-mail.
2. Dashboard → **+ New** (Add New Monitor).
3. Monitor Type **HTTP(s)**; Friendly Name `Pinpoint health`; URL
   `https://YOUR_DOMAIN/api/v1/health`; Monitoring Interval **5 minutes**.
   (Optionally add a second *Keyword* monitor for `"database":"ok"` on the same
   URL: the endpoint returns HTTP 503 itself when the DB is down.)
4. Alert Contacts: tick your e-mail; add a Telegram/Slack/Discord/webhook
   contact under **Integrations** if you want push.
5. **Create Monitor.** Optionally add a monitor on `https://YOUR_DOMAIN/` for the
   dashboard SPA, and enable SSL-expiry reminders if offered on your plan.

This checks DNS, the internet path, Caddy, the API and the database *from
outside* — everything the on-box blackbox probe cannot.

### Healthchecks.io — backup heartbeat (≈ 3 minutes)

1. Sign up at <https://healthchecks.io> (Hobbyist plan, free).
2. **Add Check** → Name `pinpoint-backup`; Period **1 day**; Grace Time **2 hours**
   (matches the `BackupStale` 26 h threshold).
3. Integrations → add your e-mail (and/or Telegram, Slack, ntfy…) and assign it to the check.
4. Copy the check's ping URL (`https://hc-ping.com/<uuid>`) and set it on the server:
   ```bash
   echo 'HEALTHCHECKS_URL=https://hc-ping.com/<uuid>' >> deploy/.env.production
   ```
5. `deploy/backup.sh` now pings `/start` when it begins, the plain URL on
   success and `/fail` on any error, so a **failed**, **missing** or **hung**
   backup alerts you from outside the box. The ping never fails the backup
   itself (it only warns).

### Healthchecks.io — dead-man's switch for the monitoring stack (≈ 2 minutes)

1. **Add Check** → Name `pinpoint-watchdog`; Period **10 minutes**; Grace **10 minutes**; same integrations.
2. Put its URL in `deploy/.env.production` and restart Alertmanager:
   ```bash
   echo 'HEALTHCHECKS_WATCHDOG_URL=https://hc-ping.com/<uuid>' >> deploy/.env.production
   dc up -d alertmanager
   ```
3. The always-firing `Watchdog` alert is forwarded to that URL every 5 minutes.
   If Prometheus, Alertmanager, Docker or the host stop, the pings stop and
   Healthchecks.io alerts you. Combined with UptimeRobot this covers "the
   box can't tell me it is dead".

Free-tier arithmetic: 2 Healthchecks checks of 20, 1–2 UptimeRobot monitors of 50.

## 5. Error tracking: decision

| Option | Cost | Weight | Verdict |
|---|---|---|---|
| Self-hosted **GlitchTip** (Sentry-compatible) | $0 | web + worker + Postgres (+ optional Redis): a second app stack to patch/back up on a small VPS | Rejected as the default: too heavy for one small host. |
| **Sentry** Developer (SaaS) | $0 for one user at a low monthly event quota (limit not re-verified this session; check sentry.io/pricing) | Needs the SDK in the API/dashboard/extension and ships stack traces + request data to a third party | Rejected as the default: new dependency, and a data-processing/privacy review. |
| **Structured logs + Prometheus (chosen)** | $0 | Already there: `pino` JSON logs with request ids; every 5xx increments `http_requests_total{status="5xx"}` with the matched route; `ApiHighErrorRate` pages you; Grafana's "Errors by route" panel shows *where*; `dc logs api` shows *what* | **Chosen.** Trade-off: no stack-trace grouping, no browser/extension-side errors, no per-user impact counts. Revisit with GlitchTip/Sentry if you need those. |

## 6. Alert reference and runbooks

All alerts are in `deploy/monitoring/alerts.yml`; each has a promtool unit test
in `deploy/monitoring/tests/alerts.test.yml` and each fires with a
`runbook` annotation pointing at the matching section below. `critical` = act
now, `warning` = look today, `info` = informational.

### Watchdog

Always firing (`severity: none`); the heartbeat for the external dead-man's
switch (§4). *Not* delivered to e-mail/chat. If Healthchecks.io says the
watchdog check is **down**: the host, Docker, Prometheus or Alertmanager is
down or cannot reach the internet. SSH in, `dc ps`, `dc logs --tail=100 prometheus alertmanager`.
If it is up but the check is down, `HEALTHCHECKS_WATCHDOG_URL` is wrong or
egress is blocked (`dc exec alertmanager wget -qO- <url>`).

### InstanceDown

`critical`. Prometheus could not scrape a target for 2 minutes; `job` says which.
`pinpoint-api`: `dc ps api`, `dc logs --tail=200 api` (the strict preflight
exits 1 on a bad secret; an `OOMKilled` shows in `docker inspect`). `node` /
`postgres` / `redis` / `blackbox`: the exporter container died — `dc up -d`.
`alertmanager`: alert delivery is down too — fix first. Verify the token:
`METRICS_TOKEN` in the env file must equal the API's (they come from the same variable).

### EdgeProbeFailed

`critical`. `GET https://caddy/api/v1/health` through the TLS edge failed 3 minutes
(non-200 or the body lacks `"database":"ok"`). Distinguish the layer:
`dc logs --tail=100 caddy` (certificate issuance, DNS), `dc exec api node -e
"fetch('http://127.0.0.1:3001/health').then(r=>r.text()).then(console.log)"` (API/DB).
This is what UptimeRobot sees too.

### DatabaseUnavailable

`critical`. The API's `SELECT 1` (`pinpoint_db_up`) or `pg_up` is 0 for 1 minute.
`dc ps db`, `dc logs --tail=100 db`; disk full is the usual cause (see
`DiskSpaceLow`); `dc restart db`. If only `pinpoint_db_up` is 0 the `pinpoint_app`
role/password may be wrong — compare `DB_APP_PASSWORD` with what `migrate`
set (`dc run --rm migrate`). Restore from backup (docs/DEPLOYMENT.md §4) only if the volume is lost.

### CertificateExpiringSoon

`warning`. Caddy renews ~30 days before expiry; under 14 days left means
renewal is failing. `dc logs caddy | grep -i -E "obtain|renew|error"`. Typical
causes: DNS no longer points here, port 80/443 blocked (ACME HTTP/TLS challenge),
Let's Encrypt rate limit. Fix the cause, then `dc restart caddy`. The `caddy_data` volume holds the certificates — never delete it.

### ApiHighErrorRate

`critical`. More than 2 % of requests returned 5xx for 5 minutes (ignored below ~0.6 req/min).
Grafana → "Errors by route" shows the route; `dc logs --since=15m api | grep '"level":50'`
shows the error and `request_id`. Common: DB errors (see `DatabaseUnavailable`),
a bad deploy (`deploy/upgrade.sh` rolls back via `PINPOINT_SERVER_IMAGE=<previous sha>`), an upstream such as SMTP/S3.

### ApiHighLatency

`warning`. p95 above 1.5 s for 10 minutes. Grafana → "Slowest routes", then
`CpuHigh` / `MemoryHigh` / `PostgresConnectionsNearMax` (resource exhaustion),
and event-loop lag on the API panel. A single heavy route (exports, screenshots) points at that code; a global rise points at the host or DB.

### ApiNoTraffic

`info` (not notified unless `ALERT_NOTIFY_INFO=true`). The API is up but served
no non-health requests for 15 minutes. Normal on a quiet install. If users
should be active: DNS/Caddy (`EdgeProbeFailed` would also fire), a CDN or firewall in front, or a broken dashboard build that never calls the API.
Silence it permanently in Alertmanager or leave it routed to the blackhole.

### ApiRestarting

`warning`. `process_start_time_seconds` changed more than twice in 15 minutes: a crash loop
or OOM kill. `dc logs --tail=300 api`, `docker inspect $(dc ps -q api) --format '{{.State.OOMKilled}} {{.State.ExitCode}}'`.
Config preflight failures exit 1 immediately and loop under `restart: unless-stopped`.

### NotificationBacklog

`warning`. More than 100 e-mail notifications pending for 15 minutes. SMTP slow or rejecting, or a burst.
`dc logs api | grep -i smtp`; test the relay credentials; the worker retries with exponential
backoff capped at 32 minutes, so a recovered relay drains the queue by itself. Inspect: `select status, count(*) from notifications group by 1;`.

### NotificationWorkerStuck

`warning`. The oldest *due* notification has waited over 15 minutes (the backoff cap is 32 min, so this
means more than normal retrying). If `pinpoint_db_up` is 1 and the API is up, the worker loop is wedged:
`dc restart api` (it uses `FOR UPDATE SKIP LOCKED`, so a restart is safe) and watch `dc logs api`.

### NotificationFailures

`warning`. At least one notification exhausted its retries (`status='failed'`) in the last hour. Usually SMTP
auth/relay problems (`select last_error from notifications where status='failed' order by updated_at desc limit 5;`).
Failed rows are not retried automatically; after fixing SMTP, requeue with
`update notifications set status='pending', attempts=0, scheduled_at=now() where status='failed';` if the mails are still wanted.

### WebhookBacklog

`warning`. More than 100 outbound webhook deliveries pending for 15 minutes — a burst of events or slow
customer endpoints holding the worker. Check `select endpoint_id, count(*) from webhook_deliveries where status='pending' group by 1 order by 2 desc;` (as the schema owner). Deliveries retry with backoff and are durable.

### WebhookWorkerStuck

`warning`. A due webhook delivery has been pending over 15 minutes: the delivery worker is dead or wedged.
`dc logs api | grep -i webhook`, then `dc restart api` (claims are leased, so a restart is safe).

### WebhookDeliveryFailures

`warning`. More than 5 deliveries newly reached `failed` in 15 minutes: customers' endpoints are rejecting
or timing out, or egress from the API is blocked (all outbound HTTP goes through the SSRF guard, which
refuses private/internal targets by design). One noisy endpoint is the customer's problem; failures across many endpoints point at DNS/egress on the host.

### QueueMetricsStale

`warning`. The API's 30-second SQL poll has not succeeded for 5 minutes, so the queue alerts are blind. It
normally accompanies `DatabaseUnavailable` — fix that first. If the DB is fine, check the API logs for errors from the poll.

### PostgresConnectionsNearMax

`warning`. More than 80 % of `max_connections` in use for 5 minutes. `select state, count(*) from pg_stat_activity group by 1;`.
Idle-in-transaction rows mean a leak. Lower `DB_POOL_MAX`, or raise Postgres `max_connections` (each connection costs memory).

### DiskSpaceLow

`warning`. A real filesystem is over 85 % used for 10 minutes. `df -h`, `docker system df`. Usual suspects:
`/var/lib/docker` (old images: `docker image prune -a`), the `db_data` volume, the `screenshots` volume,
`./backups` (lower `BACKUP_RETENTION_DAYS`, copy off-host), Prometheus (`PROMETHEUS_RETENTION_SIZE`, default 2 GB). A full disk takes Postgres down — act before 95 %.

### MemoryHigh

`warning`. Under 10 % of host memory available for 10 minutes. `docker stats --no-stream`. Postgres
`shared_buffers`/`work_mem`, the API (`ApiRestarting` if it is being OOM-killed), or the monitoring stack itself on a very small VM. Add swap or resize; the 1 GB-RAM minimum is tight with the monitoring profile on.

### CpuHigh

`warning`. Host CPU above 90 % for 15 minutes. `top`/`docker stats`; correlate with `ApiHighLatency` and traffic on the dashboard. A runaway export job or a scan are typical; sustained legitimate load means it is time to resize.

### BackupStale

`critical`. `deploy/backup.sh` has not succeeded for 26 hours (daily cron + 2 h slack). `crontab -l`,
`tail /var/log/pinpoint-backup.log`, run it by hand: `deploy/backup.sh`. Healthchecks.io (if configured) tells you the same from outside, including a hung run. Fix, run once, and the alert clears when the metric file is rewritten.

### BackupNeverRan

`critical`. No backup metric has existed for 26 hours of Prometheus uptime: `backup.sh` was never run
by cron on this host, or its textfile directory is not the one node_exporter reads. Schedule it (see
`deploy/.env.production.example`), and check `ls -l deploy/monitoring/textfile/` (or `PINPOINT_TEXTFILE_DIR`
if you changed it — the same variable must be set for backup.sh and for compose).

### AlertDeliveryFailing

`warning`. Alertmanager is failing to deliver on some integration — you may be missing alerts.
`dc logs --tail=100 alertmanager` shows the error (SMTP auth/TLS, bad webhook URL, 4xx from Discord/Slack).
Fix the credentials in `deploy/.env.production`, `dc up -d alertmanager`, and send a test (§3). Other channels you configured still work meanwhile — which is why you should configure at least two.

## 7. Operating it

- **Silence an alert** (planned maintenance): from the host, `dc exec alertmanager amtool silence add alertname=InstanceDown --duration=2h --comment="upgrade" --alertmanager.url=http://localhost:9093`.
- **Change a threshold**: edit `deploy/monitoring/alerts.yml` and its test in `deploy/monitoring/tests/alerts.test.yml`, run `deploy/monitoring/check.sh`, then `dc restart prometheus`.
- **Storage**: Prometheus keeps 15 days / 2 GB (`PROMETHEUS_RETENTION`, `PROMETHEUS_RETENTION_SIZE`), roughly 1–2 GB total for this scrape set. Grafana and Alertmanager state live in the `grafana_data` / `alertmanager_data` volumes.
- **Security**: `/metrics` stays token-gated and is not routed by Caddy; the exporters and Prometheus are only on the private Compose network; Grafana is loopback-only with sign-up and anonymous access off. The postgres exporter uses the unprivileged `pinpoint_app` role (it sees only its own sessions in `pg_stat_activity`, which is enough for these alerts).
- **Dev stack**: `docker compose --profile monitoring up` runs Prometheus + Grafana with the *same* rules and dashboard (no Alertmanager/exporters; rules for missing exporters stay idle). Alerts show at <http://localhost:9090/alerts>.
- **Resource cost** of the profile: roughly 300–500 MB RAM in total (Prometheus and Grafana dominate); skip it on hosts under 2 GB and rely on the external checks.

## 8. How it is verified in CI

`.github/workflows/monitoring.yml` runs on every PR and push to `main` (no path filter):

- **monitoring-config** — `deploy/monitoring/check.sh`: `promtool check config|rules`, `promtool test rules` (every alert has at least one firing case and most have a must-not-fire case; the script also fails if an alert lacks a test or a runbook section in this file), `amtool check-config` over an environment matrix (e-mail only, SMTP auth, every optional channel, input-validation rejects), `blackbox_exporter --config.check`, dashboard JSON, exact-version image pins, `docker compose config`, and shellcheck.
- **monitoring-smoke** — `infrastructure/scripts/monitoring-smoke.sh` boots the production stack with the monitoring profile and checks that all 9 scrape targets are up and all rules load, that the Watchdog reaches Alertmanager, that a real `deploy/backup.sh` run shows up as a metric, that Grafana is provisioned and requires login, that only Caddy (and loopback services) publish ports, and finally stops the API to prove `InstanceDown` fires, reaches Alertmanager and is delivered as an e-mail (to a throw-away SMTP sink).

Locally: `deploy/monitoring/check.sh` (uses `promtool`/`amtool`/`blackbox_exporter` from `PATH` or `$HOME/.pinpoint-dev/bin`, else Docker).

## 9. Cost summary

| Item | Cost |
|---|---|
| Prometheus, Alertmanager, Grafana, node/postgres/redis/blackbox exporters | $0 (open source, self-hosted on the existing host) |
| UptimeRobot Free: 50 monitors, 5-min interval (pricing page, 2026-11-27) | $0 |
| Healthchecks.io Hobbyist: 20 checks (pricing page, 2026-11-27) | $0 |
| E-mail alerts via the existing SMTP relay | $0 incremental |
| ntfy.sh / Discord / Slack / Telegram (optional) | $0 |
| Error tracking: structured logs + Prometheus | $0 |

Nothing in this setup needs a credit card.
