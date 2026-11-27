#!/usr/bin/env bash
# Back up a Pinpoint production stack: Postgres (pg_dump -Fc) and, for the local
# screenshot driver, the screenshots volume (tar.gz). Run on the host:
#
#   deploy/backup.sh                       # -> <repo>/backups/
#   BACKUP_DIR=/var/backups/pinpoint BACKUP_RETENTION_DAYS=30 deploy/backup.sh
#
# Environment:
#   BACKUP_DIR             destination (default: <repo>/backups)
#   BACKUP_RETENTION_DAYS  delete pinpoint-*.dump / pinpoint-screenshots-*.tar.gz
#                          older than this many days (default: 14, 0 = keep all)
#   BACKUP_INCLUDE_ENV=1   also copy deploy/.env.production (mode 600) - it holds
#                          INTEGRATION_ENCRYPTION_KEY, without which stored
#                          integration tokens are unreadable
#
# Cron (daily 02:30):
#   30 2 * * * /opt/pinpoint/deploy/backup.sh >> /var/log/pinpoint-backup.log 2>&1
#
# Copy BACKUP_DIR off the host (rsync / rclone / provider snapshots); a backup
# on the same disk is not a backup.
set -euo pipefail

# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found - run deploy/install.sh first"
command -v docker >/dev/null || die "docker is not installed"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
case "$RETENTION" in '' | *[!0-9]*) die "BACKUP_RETENTION_DAYS must be a non-negative integer" ;; esac

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
partials=()
cleanup() { [ "${#partials[@]}" -eq 0 ] || rm -f "${partials[@]}"; }
trap cleanup EXIT

log "Dumping Postgres"
dump="$BACKUP_DIR/pinpoint-$STAMP.dump"
partials+=("$dump.partial")
# shellcheck disable=SC2016 # $POSTGRES_* expand inside the container
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump.partial"
[ -s "$dump.partial" ] || die "pg_dump produced an empty file"
mv "$dump.partial" "$dump"
ok "$dump"

driver="$(env_get STORAGE_DRIVER)"
if [ "$driver" = s3 ] || { [ -z "$driver" ] && { [ -n "$(env_get S3_ENDPOINT)" ] || [ -n "$(env_get S3_ACCESS_KEY_ID)" ]; }; }; then
  log "Screenshots are in S3 - skipping the volume archive (back up the bucket with your provider)"
else
  log "Archiving the screenshots volume"
  shots="$BACKUP_DIR/pinpoint-screenshots-$STAMP.tar.gz"
  partials+=("$shots.partial")
  compose exec -T api tar -czf - -C /data/screenshots . >"$shots.partial"
  [ -s "$shots.partial" ] || die "screenshot archive is empty"
  mv "$shots.partial" "$shots"
  ok "$shots"
fi

if [ "${BACKUP_INCLUDE_ENV:-0}" = 1 ]; then
  cp "$ENV_FILE" "$BACKUP_DIR/env-$STAMP.production"
  chmod 600 "$BACKUP_DIR/env-$STAMP.production"
  ok "copied the env file (keep this backup private)"
fi

if [ "$RETENTION" -gt 0 ]; then
  log "Removing backups older than $RETENTION days"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'pinpoint-*.dump' -o -name 'pinpoint-screenshots-*.tar.gz' -o -name 'env-*.production' \) \
    -mtime "+$RETENTION" -print -delete
fi
ok "backup complete"
