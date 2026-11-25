# Pinpoint — Deployment

Pinpoint is provider-neutral: it runs anywhere you have a Linux host with
Docker (Hetzner, DigitalOcean, any VPS, or on-prem). The reference setup is
`deploy/docker-compose.prod.yml` — Postgres, Redis, a one-shot migration job,
the API, the dashboard and Caddy (automatic HTTPS). For the variable list see
the [Environment variables reference](../README.md#10-environment-variables-reference);
for what an exposed deployment must provide see
[Self-hosting](../README.md#self-hosting).

## 1. Images

Two images, both built with the **repository root as the Docker context**:

```bash
docker build -f server/Dockerfile    -t pinpoint-server    .
docker build -f dashboard/Dockerfile -t pinpoint-dashboard .
```

CI (`.github/workflows/ci.yml`) builds both on every pull request (no push)
and, on a push to `main` after lint/tests/e2e pass, publishes them to GitHub
Container Registry:

- `ghcr.io/<owner>/<repo>/server:<git-sha>` and `:latest`
- `ghcr.io/<owner>/<repo>/dashboard:<git-sha>` and `:latest`

The production compose file defaults to `ghcr.io/rk-senne/pinpoint/*:latest`;
override with `PINPOINT_SERVER_IMAGE` / `PINPOINT_DASHBOARD_IMAGE` (pin the
`<git-sha>` tag for image-exact deploys and rollbacks). If the packages are
private, `docker login ghcr.io` on the host with a token that has
`read:packages`. Without a registry, `up -d --build` builds from source.

The server image runs `node dist/index.js` on port 3001 and also runs the
migrations (`npm run migrate`, which needs the dev dependencies for `ts-node`
— on purpose). The dashboard image serves the built bundle with `vite preview`
on port 4173.

## 2. First deploy

### One command (Ubuntu 22.04 / 24.04 VPS)

```bash
git clone https://github.com/rk-senne/Pinpoint.git /opt/pinpoint
sudo /opt/pinpoint/deploy/install.sh
```

`deploy/install.sh` is idempotent. It installs Docker Engine + the compose
plugin from Docker's apt repo if missing, enables `ufw` for 22/80/443 (if
installed), asks for `DOMAIN` and `ADMIN_EMAIL` (Let's Encrypt) and optional
SMTP, generates every secret with `openssl` into `deploy/.env.production`
(mode 600, only if that file is absent), pulls the GHCR images (building from
source if they cannot be pulled), migrates, starts the stack and waits for
`https://$DOMAIN/api/v1/health`. Non-interactive: export `DOMAIN`,
`ADMIN_EMAIL` (and optionally `SMTP_*`) and set `PINPOINT_NONINTERACTIVE=1`.
Nothing else needs buying: screenshots live on a local Docker volume.
`deploy/upgrade.sh` and `deploy/backup.sh` (below) are the day-2 commands.

### Manual

Requirements: a Linux VM with Docker 24+ and Compose v2, a DNS record for your
domain pointing at it, ports 80 and 443 open (80 is needed for the ACME
challenge and the HTTP→HTTPS redirect), and an SMTP account.

```bash
git clone https://github.com/<owner>/<repo>.git /opt/pinpoint && cd /opt/pinpoint
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
$EDITOR deploy/.env.production      # set DOMAIN, every secret, SMTP_*
```

Generate the secrets (commands are also in the example file):

```bash
openssl rand -base64 48   # JWT_SECRET, OAUTH_STATE_SECRET (>= 32 bytes)
openssl rand -base64 32   # INTEGRATION_ENCRYPTION_KEY (exactly 32 bytes)
openssl rand -base64 24   # METRICS_TOKEN (>= 16 chars)
openssl rand -hex 24      # DB_PASSWORD (not "postgres")
openssl rand -hex 24      # DB_APP_PASSWORD (the unprivileged pinpoint_app role the API runs as; RLS, PP-08)
```

Start it (alias for brevity):

```bash
dc() { docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production "$@"; }
dc config -q                 # validates the file and that no secret is missing
dc pull
dc up -d
dc ps
curl -f https://$DOMAIN/health
```

`up -d` starts Postgres (named volume `db_data`, healthcheck), Redis, runs
`migrate` to completion, then starts `api`, `dashboard` and `caddy`. Only
Caddy publishes ports; everything else is on the private Compose network.
Caddy obtains the certificate on first request (keep the `caddy_data` volume,
or you will re-issue certificates and may hit rate limits). Register the first
account in the dashboard; the verification email goes through your SMTP server.

How the stack satisfies the production preflight: `NODE_ENV=production` makes
the API validate its config at boot and exit 1 if `JWT_SECRET`,
`OAUTH_STATE_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `METRICS_TOKEN` or
`DB_PASSWORD` are missing/weak, `CORS_ORIGIN` is `*`/unset, or
`COOKIE_INSECURE` is set. `CORS_ORIGIN` and `APP_URL` are derived as
`https://$DOMAIN`. The compose file sets none of the local-dev escape hatches
(`COOKIE_INSECURE`, `PINPOINT_LOCAL_DEV`).

### Reverse proxy and `TRUST_PROXY`

The dashboard must be **same-origin with the API** (first-party cookies; the
session cookie is `SameSite=Lax`; cookie-authenticated WebSockets are accepted
only from the `CORS_ORIGIN` origin). `deploy/Caddyfile` routes:

| Path | Upstream |
|---|---|
| `/api/*` | API (`/api/v1`) |
| `/socket.io/*` | API — WebSocket upgrade is handled by Caddy automatically |
| `/widget/*` | API — serves `pinpoint-widget.js` |
| `/review/*/frame` | API — review-link proxy document. `/review/:linkId` itself is a dashboard SPA route |
| everything else | dashboard (SPA) |

`/metrics` and `/health*` are deliberately not routed publicly (use
`docker compose exec api …` or Prometheus on the private network). If you use
a different proxy (nginx, Traefik, a cloud load balancer) keep the same routing
table.

Express only trusts `X-Forwarded-For` when told to. With `TRUST_PROXY` unset
every client behind the proxy shares the proxy's IP, so the per-IP rate
limiters collapse into one global bucket. The compose file sets
`TRUST_PROXY=1` (one trusted hop — Caddy). Use a hop count or a subnet list,
never `true` (rejected by the preflight on an exposed deployment). Related
knobs: `TENANT_RATE_LIMIT_MAX` (per organisation per hour, default 1000) and
`AUTH_RATE_LIMIT_IP_MAX` (per IP per minute on auth endpoints, default 20).

### Screenshot storage

`STORAGE_DRIVER=local|s3`. When unset it is `s3` if `S3_ENDPOINT` or an S3
access key is configured, otherwise `local`.

- **local (default for the prod stack)** — PNGs and markup JSON are written
  atomically (mode 0600 files, 0700 directories) under `LOCAL_STORAGE_DIR`
  (`/data/screenshots`, the `screenshots` named volume). The browser never
  sees a path: `GET /api/v1/annotations/:id/screenshot` returns a 15-minute
  HMAC-signed URL (`/api/v1/screenshots/<token>`, key derived from
  `JWT_SECRET`, `Cache-Control: private`, `image/png`, `nosniff`). Rotating
  `JWT_SECRET` only invalidates URLs already issued. `deploy/backup.sh`
  archives the volume.
- **s3** — any S3-compatible store (MinIO, Cloudflare R2, Backblaze B2,
  Wasabi, …). Set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`,
  `S3_FORCE_PATH_STYLE` (usually `true` for self-hosted), `S3_PUBLIC_BASE_URL`
  and the access key pair `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in
  `deploy/.env.production`. Create the bucket first.

Switching drivers does not migrate existing objects.

## 3. Upgrades

```bash
cd /opt/pinpoint
git pull                      # picks up compose/Caddyfile changes
dc pull                       # new images (or: dc build, if building locally)
dc run --rm migrate           # apply migrations first; abort here if it fails
dc up -d                      # recreate changed services (migrate re-runs, no-op)
dc ps && curl -f https://$DOMAIN/health
```

`up -d` also runs `migrate` before `api` (`service_completed_successfully`), so
the explicit `run --rm migrate` step is just a way to see a failing migration
before any container is replaced. Take a backup first (§4) if the release has
migrations. **Rollback:** set `PINPOINT_SERVER_IMAGE` /
`PINPOINT_DASHBOARD_IMAGE` to the previous `<git-sha>` tag and `dc up -d`.
Migrations are forward-only; if a release added one, restore the pre-upgrade
backup rather than only rolling the image back.

On `SIGTERM` the API stops its workers (awaiting in-flight work), drops idle
keep-alive connections, closes Socket.IO and the HTTP server, gives in-flight
requests up to **10 seconds**, closes Redis and the database pool and exits 0
(`GET /health/live` returns 503 once a signal was received). The compose file
sets `stop_grace_period: 30s`, above that window.

## 4. Backups and restore

Everything stateful is in Postgres, the `screenshots` volume (local storage
driver) and Caddy's certificates. The easy way:

```bash
/opt/pinpoint/deploy/backup.sh        # -> /opt/pinpoint/backups: pg_dump + screenshots tar.gz
# cron, daily 02:30, retention BACKUP_RETENTION_DAYS (default 14):
30 2 * * * /opt/pinpoint/deploy/backup.sh >> /var/log/pinpoint-backup.log 2>&1
```

`BACKUP_DIR`, `BACKUP_RETENTION_DAYS` and `BACKUP_INCLUDE_ENV=1` are
supported (see the script header). Restore the screenshots archive with
`dc exec -T api tar -xzf - -C /data/screenshots < pinpoint-screenshots-<stamp>.tar.gz`.
`deploy/upgrade.sh` takes a backup before it upgrades. By hand, back up Postgres with `pg_dump` in custom format from the
running container:

```bash
mkdir -p /var/backups/pinpoint
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > /var/backups/pinpoint/pinpoint-$(date +%F).dump
```

Daily cron (root crontab; `%` must be escaped in crontab), keeping 14 days:

```cron
30 2 * * * cd /opt/pinpoint && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/pinpoint/pinpoint-$(date +\%F).dump && find /var/backups/pinpoint -name '*.dump' -mtime +14 -delete
```

Copy the dumps off the host (rsync, rclone, your provider's volume snapshots) —
a backup on the same disk is not a backup. Also keep `deploy/.env.production`
somewhere safe: **`INTEGRATION_ENCRYPTION_KEY` is needed to read stored
integration tokens and webhook secrets**, and losing `JWT_SECRET` only signs
everyone out.

Restore into an empty database (this **replaces** the data):

```bash
dc stop api dashboard caddy
dc exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < /var/backups/pinpoint/pinpoint-YYYY-MM-DD.dump
dc up -d
```

Test a restore on a scratch host before you need it.

## 5. Health and metrics

- `GET /health` and `GET /health/ready` — 200 with
  `{"status":"ok"|"degraded","checks":{…},"info":{…}}`; **503** when the
  database check fails. `GET /health/live` is the liveness probe (the API
  container's Docker healthcheck uses it).
- `GET /metrics` — Prometheus text format (`prom-client`):
  `http_requests_total`, `http_request_duration_seconds` (labels `method`,
  `route`, `status`; `route` is the matched route pattern) and default Node
  process metrics.
  - With `METRICS_TOKEN` set, scrapers must send
    `Authorization: Bearer $METRICS_TOKEN` (401 otherwise). The boot preflight
    refuses to start an exposed deployment without it, because behind a proxy
    every caller has a private peer address.
  - The `route` label is bounded: unmatched requests under `/api/v1/<area>/*`
    use a fixed allow-list of areas, everything else is `unmatched`.

### Monitoring profile

```bash
dc --profile monitoring up -d
```

starts Prometheus (config: `deploy/prometheus.prod.yml`, scrapes `api:3001`
with `METRICS_TOKEN` as the bearer token). It publishes **no host port**:
reach it with `ssh -L 9090:localhost:9090 <host>` plus
`docker compose … port`/`exec`, or add your own authenticated exposure through
Caddy. The local dev stack's equivalent is `docker compose --profile monitoring up`
with `infrastructure/monitoring/prometheus.yml` (Prometheus + Grafana on
loopback).

## 6. Pre-deploy checklist

Do these in order the first time, and re-check items 3–6 before every deploy.

1. **Host.** Linux VM with Docker 24+/Compose v2, a firewall allowing only
   22 (ideally restricted), 80 and 443. Nothing else needs to be reachable.
2. **DNS.** `$DOMAIN` has an A/AAAA record pointing at the host *before* the
   first `up` (otherwise certificate issuance fails and retries).
3. **Secrets.** `deploy/.env.production` exists with mode 600, is not in git,
   and every value was generated (§2): `JWT_SECRET` ≥ 32 bytes,
   `OAUTH_STATE_SECRET`, `INTEGRATION_ENCRYPTION_KEY` (32 bytes),
   `METRICS_TOKEN` ≥ 16 chars, `DB_PASSWORD` ≠ `postgres`. No placeholder
   (`REPLACE_ME…`) is left. `COOKIE_INSECURE` is **not** set.
4. **Config validates.** `dc config -q` succeeds. Without a required secret the
   container exits 1 at boot (`dc logs api`).
5. **Mail.** `SMTP_*` point at a working relay and `SMTP_FROM` is an address
   that relay is allowed to send from; new accounts cannot log in until they
   verify by email.
6. **Backups.** The cron job from §4 is installed, dumps leave the host, and a
   restore has been tested.
7. **CI is green.** `main` passes the `CI` workflow (lint/typecheck, unit tests
   on Postgres, Playwright `e2e`), and the images you deploy exist in GHCR
   (`docker manifest inspect ghcr.io/<owner>/<repo>/server:<sha>`).
8. **After the deploy.** `curl -f https://$DOMAIN/health` is 200,
   `GET /widget/pinpoint-widget.js` is served, `https://$DOMAIN/metrics` is
   **not** served by the API (it falls through to the SPA), and
   `dc exec api wget -qO- http://127.0.0.1:3001/metrics` returns 401 without the
   token.

## 7. Continuous integration

`.github/workflows/ci.yml` runs on every push/PR to `main`:

| Job | What it does |
|---|---|
| `lint-typecheck` | `npm run typecheck`, `npm run lint` |
| `test` | Postgres 16 service container, migrations, full Vitest suite with coverage |
| `e2e` | Postgres + Mailpit service containers; builds every workspace, migrates, starts the API and the Vite dashboard, seeds the verified `pro` account (`infrastructure/scripts/ci-seed-e2e.sh`), installs Chromium/Firefox/WebKit, runs the `api`, `browser`, `browser-firefox`, `browser-webkit` projects, then the MV3 `extension` project under `xvfb-run`. On failure it uploads reports, traces and service logs as artifacts |
| `docker-build` (PRs) | Builds the server and dashboard images; no push, read-only token |
| `docker-publish` (push to `main`) | After the three jobs above pass, builds and pushes both images to `ghcr.io/<owner>/<repo>/{server,dashboard}` tagged `<git-sha>` and `latest`. The only job with `packages: write` |

There is no automatic deploy: pulling and restarting on the host (§3) is a
deliberate, manual step. Third-party actions are pinned to full commit SHAs
(tag in a trailing comment). Resolve a new one with
`git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag> 'refs/tags/<tag>^{}'`
(use the `^{}` commit for annotated tags).

### Verified in CI: `compose-smoke`

`.github/workflows/compose-smoke.yml` (PRs/pushes touching Docker, `deploy/`,
`server/`, `dashboard/`, `widget/`, `shared/`; also `workflow_dispatch`) boots
both Compose stacks on a GitHub-hosted runner via
`infrastructure/scripts/compose-smoke.sh dev|prod`, then always runs `down -v`
(logs are dumped and uploaded as an artifact on failure):

- **`dev`** (`docker-compose.yml`): `migrate` exited 0; `/health` is 200 with
  `checks.database: ok`; the dashboard on `:4173` serves the app shell and
  proxies `/widget/pinpoint-widget.js` as JavaScript; register → verification
  mail fetched from Mailpit → `verify-email` → login returns an `fl_session`
  cookie.
- **`prod`** (`deploy/docker-compose.prod.yml`, images built from source, a
  throwaway `.env.production` with random full-length secrets,
  `DOMAIN=localhost` so Caddy uses its internal CA): the strict preflight lets
  the API boot and its boot report is in the logs (no `COOKIE_INSECURE`);
  `https://localhost/api/v1/health`, the dashboard, the widget and the HSTS
  header work through Caddy; `/metrics` is **not** reachable through Caddy but
  is 401 without / 200 with the bearer token inside the `api` container;
  register → verified → login over HTTPS sets a `Secure` `__Host-fl_session`
  cookie; with `STORAGE_DRIVER=local`, a screenshot is uploaded, fetched back
  byte-identical through Caddy via its signed URL (a tampered URL is 403), and
  survives an API restart.

Reproduce locally (needs a working Docker, `jq`, `openssl`; the prod mode binds
ports 80/443): `bash infrastructure/scripts/compose-smoke.sh prod`.

### Shell script checks and GHCR publishing

The `shell-scripts` CI job runs `bash -n` and `shellcheck` over
`deploy/*.sh` and `infrastructure/scripts/*.sh`. The `docker-publish` job
pushes `<sha>` + `latest` on `main`. To exercise it from a branch, run the
workflow manually (Actions → ci → Run workflow, tick `publish_tag`): it
publishes only `ghcr.io/<owner>/<repo>/{server,dashboard}:test-<sha>` and never
touches `latest`. `packages: write` is granted to that job only.
