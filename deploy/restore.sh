#!/usr/bin/env bash
# Restore a Pinpoint production stack from deploy/backup.sh output.
#
#   deploy/restore.sh [--yes] <pinpoint-DATE.dump> [pinpoint-screenshots-DATE.tar.gz]
#
# This REPLACES the database (and, when an archive is given, the contents of the
# screenshots volume). Works on the running stack and on a brand-new host/volume
# (after install.sh, or `docker compose up -d db`) as long as
# deploy/.env.production is the one the backup was taken with - in particular
# INTEGRATION_ENCRYPTION_KEY must be unchanged.
#
# What it does, in order:
#   1. starts db + redis, stops api / dashboard / caddy
#   2. (re)creates the unprivileged `pinpoint_app` role from DB_APP_PASSWORD.
#      A dump carries the GRANTs and row-level-security policies that name this
#      role but not the role itself (roles are cluster-wide), and the migrations
#      will not create it again because the restored knex_migrations table says
#      they already ran. Skipping this leaves the API unable to connect.
#   3. drops and recreates the database, then pg_restore --no-owner --exit-on-error
#   4. clears and refills /data/screenshots from the archive (if given)
#   5. runs migrations (a newer release than the dump is brought up to date),
#      starts everything and waits for https://$DOMAIN/api/v1/health
set -euo pipefail

# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "usage: $0 [--yes] <pinpoint-DATE.dump> [pinpoint-screenshots-DATE.tar.gz]" >&2
  exit 2
}

main() {
  local yes=0 dump="" shots=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) yes=1 ;;
      -h | --help) usage ;;
      *)
        if [ -z "$dump" ]; then dump="$1"; elif [ -z "$shots" ]; then shots="$1"; else usage; fi
        ;;
    esac
    shift
  done
  [ -n "$dump" ] || usage
  [ -s "$dump" ] || die "dump not found or empty: $dump"
  [ -z "$shots" ] || [ -s "$shots" ] || die "screenshots archive not found or empty: $shots"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found - run deploy/install.sh (or restore your env file) first"
  command -v docker >/dev/null || die "docker is not installed"
  [ -n "$(env_get DB_APP_PASSWORD)" ] || die "DB_APP_PASSWORD is missing from $ENV_FILE"

  if [ "$yes" != 1 ]; then
    [ -t 0 ] || die "refusing to replace the database non-interactively without --yes"
    read -r -p "This REPLACES the Pinpoint database${shots:+ and screenshots} with $dump. Continue? [y/N] " reply
    case "$reply" in y | Y | yes) ;; *) die "aborted" ;; esac
  fi

  log "Starting db + redis, stopping api / dashboard / caddy"
  compose up -d --wait db redis
  compose stop api dashboard caddy

  log "Ensuring the pinpoint_app role exists with the current DB_APP_PASSWORD"
  # shellcheck disable=SC2016 # $POSTGRES_* / $DB_APP_PASSWORD expand inside the container
  compose exec -T -e "DB_APP_PASSWORD=$(env_get DB_APP_PASSWORD)" db sh -c \
    'psql -v ON_ERROR_STOP=1 -v pw="$DB_APP_PASSWORD" -U "$POSTGRES_USER" -d postgres' <<'SQL' >/dev/null
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinpoint_app')
  THEN format('ALTER ROLE pinpoint_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw')
  ELSE format('CREATE ROLE pinpoint_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw')
END \gexec
SQL

  log "Recreating the database and restoring $dump"
  # shellcheck disable=SC2016
  compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
  # shellcheck disable=SC2016
  compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' <"$dump"
  ok "database restored"

  if [ -n "$shots" ]; then
    log "Restoring screenshots from $shots"
    # --no-deps: do not (re)start the api; the one-off container only mounts the volume.
    compose run --rm --no-deps -T api sh -c 'find /data/screenshots -mindepth 1 -delete && tar -xzf - -C /data/screenshots' <"$shots"
    ok "screenshots restored"
  fi

  log "Applying migrations and starting the stack"
  compose run --rm migrate
  compose up -d --remove-orphans

  local domain
  domain="$(env_get DOMAIN)"
  log "Waiting for https://$domain/api/v1/health"
  wait_healthy "$domain" 300 || die "stack did not become healthy after the restore"
  ok "restore complete"
}

main "$@"
exit
