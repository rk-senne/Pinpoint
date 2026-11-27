#!/usr/bin/env bash
# Upgrade a running Pinpoint production stack: (git pull) -> backup -> pull
# images -> migrate -> up -d -> wait for https health.
#
#   deploy/upgrade.sh
#
# Environment:
#   PINPOINT_SKIP_GIT_PULL=1  do not `git pull --ff-only` the checkout
#   PINPOINT_SKIP_BACKUP=1    skip the pre-upgrade backup (not recommended)
#   PINPOINT_BUILD=1          build images from source instead of pulling
#
# Rollback: set PINPOINT_SERVER_IMAGE / PINPOINT_DASHBOARD_IMAGE in
# deploy/.env.production to the previous <git-sha> tag and run
# `deploy/upgrade.sh` again with PINPOINT_SKIP_GIT_PULL=1 (migrations are
# forward-only: restore the pre-upgrade backup if a release added one).
set -euo pipefail

# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Everything lives in a function so bash has parsed the whole script before
# `git pull` can replace this file underneath it.
main() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found - run deploy/install.sh first"
  command -v docker >/dev/null || die "docker is not installed"

  if [ "${PINPOINT_SKIP_GIT_PULL:-0}" != 1 ] && [ -d "$REPO_ROOT/.git" ]; then
    log "Updating the checkout"
    git -C "$REPO_ROOT" pull --ff-only
  fi

  # ACME_EMAIL became required (Let's Encrypt expiry notices); older env files lack it.
  if [ -z "$(env_get ACME_EMAIL)" ]; then
    email="${ADMIN_EMAIL:-}"
    if [ -z "$email" ] && [ -t 0 ]; then read -r -p "Admin email for Let's Encrypt notices: " email; fi
    [ -n "$email" ] || die "ACME_EMAIL is missing from $ENV_FILE; set it (or export ADMIN_EMAIL) and re-run"
    env_set ACME_EMAIL "$email"
    ok "added ACME_EMAIL to $ENV_FILE"
  fi

  # DB_APP_PASSWORD (the unprivileged pinpoint_app role the API runs as, so RLS
  # applies) is new; older env files lack it. Generate it once.
  if [ -z "$(env_get DB_APP_PASSWORD)" ]; then
    env_set DB_APP_PASSWORD "$(openssl rand -hex 24)"
    ok "added DB_APP_PASSWORD to $ENV_FILE"
  fi

  if [ "${PINPOINT_SKIP_BACKUP:-0}" != 1 ]; then
    log "Pre-upgrade backup"
    "$DEPLOY_DIR/backup.sh"
  fi

  pull_or_build

  log "Applying migrations"
  compose run --rm migrate

  log "Recreating changed services"
  compose up -d --remove-orphans

  domain="$(env_get DOMAIN)"
  log "Waiting for https://$domain/api/v1/health"
  wait_healthy "$domain" 300 || die "stack did not become healthy"
  compose ps
  ok "upgrade complete"
}

main "$@"
exit
