# 05 — Business Continuity, Backup & Disaster Recovery

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<engineering lead>` | `<management>` | Annual; **restore test quarterly** | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim. RPO/RTO below are *targets to choose*, not
measured results.

## 1. System recap
Single VM running Docker Compose (`deploy/docker-compose.prod.yml`): Postgres 16, Redis, API, dashboard, Caddy. State lives in:
Postgres (`db_data`), screenshots (`screenshots` volume when `STORAGE_DRIVER=local`, otherwise your bucket), Caddy
certificates (`caddy_data`), and `deploy/.env.production` (secrets — **`INTEGRATION_ENCRYPTION_KEY` is required to read
stored integration tokens and webhook secrets**). Redis holds only rate-limit/socket-adapter state (loss is harmless).

## 2. Objectives (choose and record)
| | Starting target | Meaning with the current design |
|---|---|---|
| **RPO** | 24 h | Daily `deploy/backup.sh` ⇒ up to ~24 h of data lost. Lower it (e.g. hourly `pg_dump`, or provider snapshots + WAL archiving) only if customers need it. |
| **RTO** | 4 h | Time to provision a new VM, `install.sh`, restore dump + screenshots, repoint DNS. Verify by measuring in the restore test. |

## 3. Backups
- **What runs:** `deploy/backup.sh` — `pg_dump -Fc` of the database, a `tar.gz` of the screenshots volume (local driver; skipped with a note when S3 is used), optional env-file copy with `BACKUP_INCLUDE_ENV=1`. Atomic writes (`.partial` → rename), dir mode 700, retention `BACKUP_RETENTION_DAYS` (default 14).
- **Schedule:** cron `30 2 * * * /opt/pinpoint/deploy/backup.sh >> /var/log/pinpoint-backup.log 2>&1`. `deploy/upgrade.sh` also takes a backup first.
- **Off-box copy (required):** a backup on the same disk is not a backup. Copy `BACKUP_DIR` nightly to a different provider/account (rclone/rsync to object storage, or another host) **encrypted** (e.g. `rclone crypt`, `age`) — dumps contain customer data. Keep ≥ 14 days off-box, ≥ 35 days preferred.
- **Secrets:** store `deploy/.env.production` separately in the password manager / sealed storage (not only in the same backup bucket as the dumps).
- **Monitoring:** alert if the newest `pinpoint-*.dump` is > 26 h old or empty (`<mechanism>`).
- Provider snapshots are an optional extra layer, not a replacement for logical dumps (they are crash-consistent at best).

## 4. Restore-test procedure (quarterly; record the result)
Use a scratch VM — never test on production.
1. Record start time. Provision a clean Ubuntu VM; `git clone … /opt/pinpoint`; place the saved `deploy/.env.production` (use a test `DOMAIN` or `localhost`).
2. `deploy/install.sh` (or `dc up -d db` only) to get an empty stack.
3. Restore (from `docs/DEPLOYMENT.md §4`):
   ```bash
   dc stop api dashboard caddy
   dc exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < pinpoint-<stamp>.dump
   dc exec -T api tar -xzf - -C /data/screenshots < pinpoint-screenshots-<stamp>.tar.gz
   dc run --rm migrate && dc up -d
   ```
   (After `--no-owner` the `pinpoint_app` role/grants come from the migration step; confirm the API starts as `pinpoint_app`.)
4. Verify: `/health` 200; log in as a known test user; open a project; open a screenshot; check row counts (`projects`, `annotations`, `comments`) against production; confirm an integration token decrypts (a connected test integration lists targets).
5. Record: backup used (age), time to restore (= measured RTO), data age (= measured RPO), problems found, sign-off. Fix gaps before the next quarter.

## 5. Disaster scenarios
| Scenario | Action |
|---|---|
| Container/service crash | `restart: unless-stopped`; check `docker compose ps`/logs. |
| Bad deploy | Set `PINPOINT_*_IMAGE` to the previous `<git-sha>`; if a migration ran, restore the pre-upgrade backup. |
| Host lost / provider outage | Provision a new VM (any provider), `install.sh`, restore latest off-box backup, update DNS (set TTL ≤ 300 s in advance). |
| Data corruption/deletion | Restore into a scratch DB, extract affected rows, or full restore per §4. |
| Key loss (`.env.production`) | Restore from the separate secret store; without `INTEGRATION_ENCRYPTION_KEY` integrations must be reconnected. |

## 6. Communications and capacity
Use the contacts and templates in [04](04-incident-response-plan.md); publish status `<page/URL>`. Review disk, memory and
DB size monthly (`docker system df`, `df -h`); resize before 80 % disk.

## 7. Sign-off
Approved by `<name>` on `<date>`. Last restore test: `<date / result>`.
