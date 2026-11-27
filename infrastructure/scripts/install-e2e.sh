#!/usr/bin/env bash
# End-to-end test of the owner's real go-live path on a fresh Ubuntu machine
# (GitHub-hosted ubuntu-24.04 runner: Docker preinstalled, passwordless sudo).
#
#   INSTALL_E2E_I_UNDERSTAND=1 bash infrastructure/scripts/install-e2e.sh
#
# Covers: copy the repo to /opt/pinpoint -> deploy/install.sh (non-interactive,
# DOMAIN=localhost so Caddy uses its internal CA) -> re-run install.sh
# (idempotent, secrets untouched) -> register/verify/login, project, annotation,
# screenshot upload + signed-URL fetch -> deploy/backup.sh -> wipe every volume
# and restore with deploy/restore.sh -> deploy/upgrade.sh. On failure it prints
# `compose ps` + logs; the stack is always torn down (`down -v`).
#
# DESTRUCTIVE: writes /opt/pinpoint, binds ports 80/443, runs `down -v` on the
# Compose project "pinpoint". It refuses to run outside GitHub Actions unless
# INSTALL_E2E_I_UNDERSTAND=1.
#
# Environment:
#   PINPOINT_BUILD=1|0            build images from source (default 1) or pull
#   PINPOINT_SERVER_IMAGE / PINPOINT_DASHBOARD_IMAGE
#                                 use pre-built images (e.g. ghcr.io/<o>/<r>/server:test-<sha>);
#                                 when both are set PINPOINT_BUILD defaults to 0
#   INSTALL_E2E_DIR               install dir (default /opt/pinpoint)
#   INSTALL_E2E_LOG_DIR           where logs are written (default ./install-e2e-logs)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${INSTALL_E2E_DIR:-/opt/pinpoint}"
LOG_DIR="${INSTALL_E2E_LOG_DIR:-$ROOT/install-e2e-logs}"
ENV_FILE="$APP_DIR/deploy/.env.production"
COMPOSE_FILE="$APP_DIR/deploy/docker-compose.prod.yml"
BACKUP_DIR="$APP_DIR/backups"
BASE=https://localhost
TIMEOUT_S="${INSTALL_E2E_TIMEOUT_S:-300}"
EMAIL="install-e2e-$(date +%s)-$RANDOM@example.test"
PASSWORD='Install-E2E-Pw-7q2m!x'
TMP="$(mktemp -d)"
PID="" ANN="" PNG="$TMP/shot.png"

if [ -n "${PINPOINT_SERVER_IMAGE:-}" ] && [ -n "${PINPOINT_DASHBOARD_IMAGE:-}" ]; then
  BUILD="${PINPOINT_BUILD:-0}"
else
  BUILD="${PINPOINT_BUILD:-1}"
fi

# Variables handed to every root command (sudo would otherwise drop them).
PASSTHRU=(
  PINPOINT_NONINTERACTIVE=1 DOMAIN=localhost ADMIN_EMAIL=ops@example.com
  PINPOINT_SKIP_UFW=1 "PINPOINT_BUILD=$BUILD" PINPOINT_SKIP_GIT_PULL=1
)
[ -z "${PINPOINT_SERVER_IMAGE:-}" ] || PASSTHRU+=("PINPOINT_SERVER_IMAGE=$PINPOINT_SERVER_IMAGE")
[ -z "${PINPOINT_DASHBOARD_IMAGE:-}" ] || PASSTHRU+=("PINPOINT_DASHBOARD_IMAGE=$PINPOINT_DASHBOARD_IMAGE")

step() { printf '\n==> %s\n' "$*"; }
okay() { echo "ok   $*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# as_root <cmd...>: run as root with the passthrough variables (`env` avoids
# sudoers SETENV restrictions on VAR=value arguments).
as_root() { sudo env "${PASSTHRU[@]}" "$@"; }
# dc <args...>: docker compose against the installed production stack.
dc() { as_root docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
# envval NAME: value from the (root-only) env file.
envval() { sudo awk -v k="$1" 'index($0, k "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"; }

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ]; then
    echo "--- install-e2e FAILED (exit $rc); collecting logs ---" >&2
    mkdir -p "$LOG_DIR"
    dc ps -a >"$LOG_DIR/compose-ps.txt" 2>&1
    dc logs --no-color >"$LOG_DIR/compose.log" 2>&1
    cat "$LOG_DIR/compose-ps.txt" >&2
    tail -n 200 "$LOG_DIR/compose.log" >&2
    { sudo ls -la "$APP_DIR/deploy" "$BACKUP_DIR"; } >"$LOG_DIR/ls.txt" 2>&1
  fi
  echo "--- tearing down the stack ---"
  dc down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

# retry <seconds> <description> <command...>
retry() {
  local secs="$1" what="$2" end
  shift 2
  end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || fail "timed out after ${secs}s waiting for: $what"
    sleep 3
  done
}

# logged <name> <cmd...>: run, tee into $LOG_DIR/<name>.log, keep the exit code.
logged() {
  local name="$1" rc
  shift
  mkdir -p "$LOG_DIR"
  set +e
  "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

http_code() { curl -sSk -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
login_payload() { jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}'; }
health_ok() { [ "$(curl -fsSk --max-time 15 "$BASE/api/v1/health" | jq -r '.checks.database // empty')" = ok ]; }

preflight() {
  step "Preconditions"
  if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${INSTALL_E2E_I_UNDERSTAND:-}" != 1 ]; then
    fail "destructive test (writes $APP_DIR, binds 80/443, runs 'down -v'): set INSTALL_E2E_I_UNDERSTAND=1"
  fi
  local t
  for t in docker curl jq openssl sudo tar base64; do command -v "$t" >/dev/null || fail "$t is required"; done
  sudo -n true || fail "passwordless sudo is required"
  docker compose version
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "OS: ${PRETTY_NAME:-unknown}"
  # Ports 80/443 must be free for Caddy. Hosted images ship (disabled) nginx/apache; stop them if running.
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':(80|443)$'; then
    echo "ports 80/443 are in use; stopping apache2/nginx if present"
    sudo systemctl stop apache2 nginx 2>/dev/null || true
    sleep 2
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':(80|443)$'; then
      ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' || true
      fail "ports 80/443 are still in use"
    fi
  fi
  if sudo test -e "$ENV_FILE"; then fail "$ENV_FILE already exists - refusing to touch a real install"; fi
  # 1x1 PNG
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' |
    base64 -d >"$PNG"
}

copy_repo() {
  step "Copy the checkout to $APP_DIR (as the docs say: /opt/pinpoint)"
  sudo mkdir -p "$APP_DIR"
  # No .git: a CI checkout is a detached HEAD, which `git pull` in upgrade.sh would reject.
  tar -C "$ROOT" --exclude=./.git --exclude=node_modules --exclude=./install-e2e-logs -cf - . |
    sudo tar -C "$APP_DIR" -xf -
  sudo test -x "$APP_DIR/deploy/install.sh" || fail "deploy/install.sh is not executable after the copy"
  okay "repo copied"
}

SECRET_NAMES=(JWT_SECRET OAUTH_STATE_SECRET INTEGRATION_ENCRYPTION_KEY METRICS_TOKEN DB_PASSWORD DB_APP_PASSWORD)

assert_env_file() {
  step "deploy/.env.production: mode 600, every secret generated at real length"
  [ "$(sudo stat -c %a "$ENV_FILE")" = 600 ] || fail "$ENV_FILE mode is $(sudo stat -c %a "$ENV_FILE"), expected 600"
  okay "mode 600"
  local n v min
  for n in "${SECRET_NAMES[@]}"; do
    v="$(envval "$n")"
    [ -n "$v" ] || fail "$n is empty"
    case "$v" in *REPLACE_ME*) fail "$n still holds the example placeholder" ;; esac
    min=32
    case "$n" in JWT_SECRET | OAUTH_STATE_SECRET) min=48 ;; esac
    [ "${#v}" -ge "$min" ] || fail "$n is only ${#v} chars (expected >= $min)"
    okay "$n set (${#v} chars)"
  done
  [ "$(envval INTEGRATION_ENCRYPTION_KEY | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ||
    fail "INTEGRATION_ENCRYPTION_KEY does not decode to 32 bytes"
  [ "$(envval DB_PASSWORD)" != postgres ] || fail "DB_PASSWORD is the default"
  [ "$(envval DB_PASSWORD)" != "$(envval DB_APP_PASSWORD)" ] || fail "DB_PASSWORD and DB_APP_PASSWORD are identical"
  [ "$(envval DOMAIN)" = localhost ] || fail "DOMAIN is '$(envval DOMAIN)'"
  [ "$(envval ACME_EMAIL)" = ops@example.com ] || fail "ACME_EMAIL is '$(envval ACME_EMAIL)'"
  okay "INTEGRATION_ENCRYPTION_KEY is 32 bytes; DOMAIN/ACME_EMAIL from the environment"
}

assert_health() {
  retry "$TIMEOUT_S" "https://localhost/api/v1/health database ok" health_ok
  okay "$1: https://localhost/api/v1/health reports database ok"
}

# ---- application checks ------------------------------------------------------

api_login_token() {
  local out
  out="$(curl -sSk --max-time 20 -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' -d "$(login_payload)")" || return 1
  jq -er '.token' <<<"$out"
}

create_data() {
  step "register -> verify (DB) -> login (Secure __Host-fl_session)"
  [ "$(http_code -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p,name:"Install E2E"}')")" = 201 ] ||
    fail "register did not return 201"
  okay "register 201"
  # No mail sink on a real install: mark verified in Postgres (the documented manual step).
  # shellcheck disable=SC2016 # $POSTGRES_* expand inside the container
  echo "update users set verified = true where email = '$EMAIL';" |
    dc exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null ||
    fail "could not mark the user verified"
  local hdrs="$TMP/login.headers"
  [ "$(http_code -D "$hdrs" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' -d "$(login_payload)")" = 200 ] ||
    fail "login did not return 200"
  grep -iE '^set-cookie: __Host-fl_session=.*;[[:space:]]*Secure' "$hdrs" >/dev/null ||
    fail "login lacks a Secure __Host-fl_session cookie: $(grep -i '^set-cookie' "$hdrs" | sed 's/=[^;]*/=<redacted>/')"
  okay "login 200 with Secure __Host-fl_session cookie"

  step "project + annotation + screenshot upload"
  local token auth proj page body
  token="$(api_login_token)" || fail "login body lacks a bearer token"
  auth="Authorization: Bearer $token"
  proj="$(curl -sSk --max-time 20 -X POST "$BASE/api/v1/projects" -H "$auth" -H 'Content-Type: application/json' \
    -d '{"name":"install-e2e","urls":["https://example.com/"]}')" || fail "create project failed"
  PID="$(jq -r '.project.id // .id // empty' <<<"$proj")"
  page="$(jq -r '(.project.pages // .pages)[0].url // empty' <<<"$proj")"
  [ -n "$PID" ] && [ -n "$page" ] || fail "unexpected project response: $proj"
  body="$(jq -nc --arg u "$page" '{pageUrl:$u,body:"install-e2e annotation",type:"note",severity:"minor",
      target:{cssSelector:"body",xpath:"/html/body",pageX:1,pageY:1,tagName:"BODY",textSnippet:""},
      environment:{browserFamily:"Chrome",browserVersion:"120.0",osFamily:"macOS",osVersion:"14.0",deviceType:"desktop",userAgentRaw:"install-e2e"}}')"
  ANN="$(curl -sSk --max-time 20 -X POST "$BASE/api/v1/projects/$PID/annotations" -H "$auth" -H 'Content-Type: application/json' -d "$body" |
    jq -r '.annotation.id // empty')"
  [ -n "$ANN" ] || fail "annotation id missing"
  [ "$(http_code -X POST "$BASE/api/v1/annotations/$ANN/screenshot" -H "$auth" -F "image=@$PNG;type=image/png")" = 200 ] ||
    fail "screenshot upload did not return 200"
  okay "project $PID, annotation $ANN, screenshot uploaded"
  check_screenshot "$token"
}

# check_screenshot <token>: fetch the PNG through its signed URL, compare bytes.
check_screenshot() {
  local auth="Authorization: Bearer $1" url got="$TMP/shot.fetched"
  url="$(curl -sSk --max-time 20 "$BASE/api/v1/annotations/$ANN/screenshot" -H "$auth" | jq -r '.screenshotUrl // empty')"
  case "$url" in *"/api/v1/screenshots/"*) ;; *) fail "unexpected screenshot url: '$url'" ;; esac
  [ "$(curl -sSk --max-time 20 -o "$got" -w '%{http_code}' "$url")" = 200 ] || fail "signed URL fetch did not return 200"
  cmp -s "$PNG" "$got" || fail "fetched screenshot differs from the uploaded bytes"
  okay "screenshot bytes identical via the signed URL"
}

# check_data <label>: user can log in, project + annotation exist, screenshot intact.
check_data() {
  step "data present ($1)"
  local token auth
  token="$(api_login_token)" || fail "login failed ($1)"
  auth="Authorization: Bearer $token"
  curl -sSk --max-time 20 "$BASE/api/v1/projects" -H "$auth" | jq -e --arg id "$PID" '[.. | objects | select(.id? == $id)] | length > 0' >/dev/null ||
    fail "project $PID missing ($1)"
  curl -sSk --max-time 20 "$BASE/api/v1/projects/$PID/annotations" -H "$auth" |
    jq -e --arg id "$ANN" '[.. | objects | select(.id? == $id)] | length > 0' >/dev/null || fail "annotation $ANN missing ($1)"
  okay "login, project and annotation present"
  check_screenshot "$token"
}

latest_backup() { sudo find "$BACKUP_DIR" -maxdepth 1 -type f -name "$1" -size +0 -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-; }
count_backups() { sudo find "$BACKUP_DIR" -maxdepth 1 -type f -name 'pinpoint-*.dump' -size +0 | wc -l; }

# ---- the scenario ------------------------------------------------------------

preflight
copy_repo

step "1. install.sh on a fresh machine"
logged install-1 as_root "$APP_DIR/deploy/install.sh" || fail "install.sh exited non-zero"
grep -q 'Docker + compose plugin already installed' "$LOG_DIR/install-1.log" || fail "install.sh did not detect the preinstalled Docker"
okay "install.sh exit 0; existing Docker detected (not reinstalled)"
assert_env_file
assert_health "after install"
SECRETS_1="$(sudo sha256sum "$ENV_FILE" | cut -d' ' -f1)"

step "2. install.sh again (idempotent)"
logged install-2 as_root "$APP_DIR/deploy/install.sh" || fail "second install.sh exited non-zero"
[ "$(sudo sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$SECRETS_1" ] || fail ".env.production changed on the second install.sh run"
grep -q 'keeping all existing secrets' "$LOG_DIR/install-2.log" || fail "second run did not report keeping the existing secrets"
assert_health "after second install"
okay "second run exit 0; .env.production byte-identical"

step "3. the app works"
create_data

step "4. backup.sh"
logged backup as_root "$APP_DIR/deploy/backup.sh" || fail "backup.sh exited non-zero"
[ "$(sudo stat -c %a "$BACKUP_DIR")" = 700 ] || fail "backup dir mode is $(sudo stat -c %a "$BACKUP_DIR"), expected 700"
DUMP="$(latest_backup 'pinpoint-*.dump')"
SHOTS="$(latest_backup 'pinpoint-screenshots-*.tar.gz')"
[ -n "$DUMP" ] || fail "no non-empty pinpoint-*.dump in $BACKUP_DIR"
[ -n "$SHOTS" ] || fail "no non-empty pinpoint-screenshots-*.tar.gz in $BACKUP_DIR"
sudo tar -tzf "$SHOTS" | grep -q . || fail "screenshots archive lists no entries"
okay "backup dir mode 700; $(basename "$DUMP"), $(basename "$SHOTS")"

step "5. restore drill: wipe every volume, reinstall empty, restore.sh"
dc down -v --remove-orphans
if docker volume ls -q | grep -q '^pinpoint_'; then
  docker volume ls -q | grep '^pinpoint_' >&2
  fail "pinpoint volumes survived 'down -v'"
fi
okay "all volumes wiped"
logged install-3 as_root "$APP_DIR/deploy/install.sh" || fail "install.sh on the wiped host exited non-zero"
assert_health "empty stack"
[ "$(http_code -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' -d "$(login_payload)")" != 200 ] ||
  fail "user can log in on the empty stack - the wipe did not work"
okay "empty stack: the user does not exist yet"
logged restore as_root "$APP_DIR/deploy/restore.sh" --yes "$DUMP" "$SHOTS" || fail "restore.sh exited non-zero"
assert_health "after restore"
check_data "after restore"

step "6. upgrade.sh"
BEFORE="$(count_backups)"
logged upgrade as_root "$APP_DIR/deploy/upgrade.sh" || fail "upgrade.sh exited non-zero"
AFTER="$(count_backups)"
[ "$AFTER" -gt "$BEFORE" ] || fail "upgrade.sh wrote no pre-upgrade backup ($BEFORE -> $AFTER dumps)"
okay "upgrade exit 0; pre-upgrade backup written ($BEFORE -> $AFTER dumps)"
assert_health "after upgrade"
check_data "after upgrade"

echo
echo "install-e2e: ALL CHECKS PASSED"
