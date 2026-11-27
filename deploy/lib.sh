# shellcheck shell=bash
# Shared helpers for deploy/install.sh, deploy/upgrade.sh and deploy/backup.sh.
# Sourced, never executed. Callers must `set -euo pipefail` first.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
export REPO_ROOT
ENV_FILE="${PINPOINT_ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2
  exit 1
}

# compose <args...>: docker compose against the production stack + env file.
compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# env_get NAME: print the value of NAME from the env file (empty if absent).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

# env_set NAME VALUE: replace NAME=... in the env file (append if absent).
# The value is passed through the environment so no character needs escaping.
env_set() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# is_local_domain DOMAIN: true for names Caddy serves with its internal CA.
is_local_domain() {
  case "$1" in
    localhost | *.localhost | *.local | *.test | 127.0.0.1) return 0 ;;
    *) return 1 ;;
  esac
}

# wait_healthy DOMAIN [SECONDS]: poll https://DOMAIN/api/v1/health until the
# database check reports ok. Certificates are issued on first request, so the
# first minutes can legitimately fail.
wait_healthy() {
  local domain="$1" secs="${2:-300}" end curl_opts=(-fsS --max-time 10) body
  if is_local_domain "$domain"; then curl_opts+=(-k); fi
  end=$((SECONDS + secs))
  until body="$(curl "${curl_opts[@]}" "https://$domain/api/v1/health" 2>/dev/null)" &&
    printf '%s' "$body" | grep -q '"database":"ok"'; do
    if [ "$SECONDS" -ge "$end" ]; then
      warn "no healthy response from https://$domain/api/v1/health after ${secs}s"
      warn "check DNS (A/AAAA record -> this host), ports 80/443, and: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production logs --tail=100 caddy api"
      return 1
    fi
    sleep 5
  done
  return 0
}

# pull_or_build: fetch the GHCR images; build from source when they are not
# published (or not pullable) yet.
pull_or_build() {
  if [ "${PINPOINT_BUILD:-0}" = 1 ]; then
    log "Building images from source (PINPOINT_BUILD=1)"
    compose build api dashboard
    return
  fi
  log "Pulling images"
  if compose pull --quiet api dashboard; then
    ok "images pulled"
  else
    warn "could not pull the Pinpoint images from GHCR - building from source instead"
    compose build api dashboard
  fi
}
