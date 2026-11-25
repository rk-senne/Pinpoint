#!/usr/bin/env bash
# Boot a Pinpoint Compose stack for real and assert it works end to end.
#
#   infrastructure/scripts/compose-smoke.sh dev    # docker-compose.yml
#   infrastructure/scripts/compose-smoke.sh prod   # deploy/docker-compose.prod.yml (+ Caddy, https://localhost)
#
# Needs: docker compose v2, curl, jq, openssl. Always tears the stack down
# (`down -v`); on failure it dumps `docker compose logs` and writes them to
# $SMOKE_LOG_DIR (default: ./compose-smoke-logs) for CI artifact upload.
#
# Why we poll instead of `up --wait`: `--wait` treats the one-shot `migrate`
# service exiting (code 0) as an error on several Compose versions, so we
# start detached and poll the endpoints + inspect migrate's exit code.
set -euo pipefail

MODE="${1:-}"
case "$MODE" in dev | prod) ;; *)
  echo "usage: $0 dev|prod" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${SMOKE_LOG_DIR:-$ROOT/compose-smoke-logs}"
TMP="$(mktemp -d)"
TIMEOUT_S="${SMOKE_TIMEOUT_S:-240}"
EMAIL="smoke-$(date +%s)-$RANDOM@example.test"
PASSWORD='Smoke-Test-Pw-9f3k2!'

if [ "$MODE" = dev ]; then
  COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")
else
  COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.prod.yml" --env-file "$TMP/.env.production")
fi

step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- smoke test FAILED (exit $rc); collecting logs ---" >&2
    mkdir -p "$LOG_DIR"
    "${COMPOSE[@]}" ps -a >"$LOG_DIR/ps-$MODE.txt" 2>&1 || true
    "${COMPOSE[@]}" logs --no-color >"$LOG_DIR/compose-$MODE.log" 2>&1 || true
    "${COMPOSE[@]}" ps -a 2>&1 || true
    "${COMPOSE[@]}" logs --no-color --tail=200 2>&1 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

# retry <seconds> <description> <command...>: poll until the command succeeds.
retry() {
  local secs="$1" what="$2" end
  shift 2
  end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || fail "timed out after ${secs}s waiting for: $what"
    sleep 3
  done
}

# http_code <curl args...> -> prints the status code only.
http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

assert_code() { # <expected> <description> <curl args...>
  local want="$1" what="$2" got
  shift 2
  got="$(http_code "$@")" || got="curl-error"
  [ "$got" = "$want" ] || fail "$what: expected HTTP $want, got $got"
  echo "ok   $what -> $got"
}

assert_migrate_ok() {
  local cid state code
  cid="$("${COMPOSE[@]}" ps -a -q migrate)"
  [ -n "$cid" ] || fail "migrate container not found"
  retry 120 "migrate container to exit" \
    bash -c "[ \"\$(docker inspect -f '{{.State.Status}}' $cid)\" = exited ]"
  state="$(docker inspect -f '{{.State.Status}}' "$cid")"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  [ "$state" = exited ] && [ "$code" = 0 ] || fail "migrate: state=$state exit=$code"
  echo "ok   migrate exited 0"
}

register_payload() {
  jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p,name:"Smoke Test"}'
}
login_payload() { jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}'; }

smoke_dev() {
  local app=http://127.0.0.1:4173 api=http://127.0.0.1:3001 mail=http://127.0.0.1:8025

  step "docker compose up (dev)"
  "${COMPOSE[@]}" up -d --build

  assert_migrate_ok
  retry "$TIMEOUT_S" "API /health" curl -fsS "$api/health"
  retry "$TIMEOUT_S" "dashboard /" curl -fsS "$app/"

  step "API health"
  local health
  health="$(curl -sS --max-time 15 -w '\n%{http_code}' "$api/health")"
  [ "${health##*$'\n'}" = 200 ] || fail "/health status ${health##*$'\n'}"
  [ "$(printf '%s' "${health%$'\n'*}" | jq -r '.checks.database')" = ok ] || fail "/health checks.database != ok: $health"
  echo "ok   /health 200, checks.database=ok"

  step "dashboard HTML + widget through the dashboard origin"
  # Capture first: `curl | grep -q` under pipefail fails with curl (23) when grep exits early.
  local html; html="$(curl -fsS --max-time 15 "$app/")" || fail "dashboard did not respond"
  grep -q 'id="root"' <<<"$html" || fail "dashboard HTML lacks the app root"
  echo "ok   dashboard serves HTML with app root"
  local ct
  ct="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{content_type}' "$app/widget/pinpoint-widget.js")"
  case "$ct" in "200 "*javascript*) echo "ok   widget via dashboard origin -> $ct" ;; *) fail "widget: $ct" ;; esac

  step "register -> Mailpit -> verify -> login (via dashboard origin)"
  assert_code 201 "register" -X POST "$app/api/v1/auth/register" \
    -H 'Content-Type: application/json' -d "$(register_payload)"

  local id token=""
  for _ in $(seq 1 30); do
    id="$(curl -fsS --max-time 10 --get "$mail/api/v1/search" --data-urlencode "query=to:$EMAIL" |
      jq -r '.messages[0].ID // empty' 2>/dev/null || true)"
    if [ -n "$id" ]; then
      token="$(curl -fsS --max-time 10 "$mail/api/v1/message/$id" |
        jq -r '.Text, .HTML' | grep -oE 'verify-email/[A-Za-z0-9_.~%-]+' | head -1 | cut -d/ -f2 || true)"
      [ -z "$token" ] || break
    fi
    sleep 2
  done
  [ -n "$token" ] || fail "no verification token found in Mailpit for $EMAIL"
  echo "ok   verification mail captured by Mailpit"

  assert_code 200 "verify-email" -X POST "$app/api/v1/auth/verify-email/$token"

  local hdrs="$TMP/login.headers"
  [ "$(http_code -D "$hdrs" -X POST "$app/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d "$(login_payload)")" = 200 ] || fail "login did not return 200"
  grep -qi '^set-cookie: fl_session=' "$hdrs" || fail "login response lacks fl_session cookie"
  echo "ok   login 200 with fl_session cookie"
}

gen_prod_env() {
  # Real-length random secrets satisfying the strict preflight.
  local f="$TMP/.env.production" key
  cp "$ROOT/deploy/.env.production.example" "$f"
  set_var() { # set_var NAME VALUE (values are base64/hex: no sed metacharacters besides /, use | delimiter)
    sed -i.bak "s|^$1=.*|$1=$2|" "$f"
  }
  set_var DOMAIN localhost
  set_var JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  set_var OAUTH_STATE_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  key="$(openssl rand -base64 32 | tr -d '\n')"
  set_var INTEGRATION_ENCRYPTION_KEY "$key"
  METRICS_TOKEN="$(openssl rand -hex 24)"
  set_var METRICS_TOKEN "$METRICS_TOKEN"
  set_var DB_PASSWORD "$(openssl rand -hex 24)"
  set_var ACME_EMAIL smoke@example.test
  set_var SMTP_HOST localhost
  set_var SMTP_FROM no-reply@localhost
  rm -f "$f.bak"
  chmod 600 "$f"
  # Screenshots on the local-disk driver (no S3 provider needed).
  echo "STORAGE_DRIVER=local" >>"$f"
  # Build locally (no GHCR pull) under CI-local image names.
  {
    echo "PINPOINT_SERVER_IMAGE=pinpoint-server:compose-smoke"
    echo "PINPOINT_DASHBOARD_IMAGE=pinpoint-dashboard:compose-smoke"
  } >>"$f"
}

smoke_prod() {
  local base=https://localhost ct
  gen_prod_env

  step "docker compose config (prod)"
  "${COMPOSE[@]}" config -q

  step "docker compose up --build (prod)"
  "${COMPOSE[@]}" up -d --build

  assert_migrate_ok
  # -k: Caddy's internal CA is not in the runner's trust store.
  retry "$TIMEOUT_S" "API health through Caddy" curl -fsSk "$base/api/v1/health"

  step "health + dashboard through Caddy (https://localhost)"
  local body
  body="$(curl -sSk --max-time 15 "$base/api/v1/health")"
  [ "$(printf '%s' "$body" | jq -r '.checks.database // .status')" = ok ] || fail "health body: $body"
  echo "ok   /api/v1/health 200, database ok (via Caddy)"
  # /health itself is intentionally not routed by Caddy; check it in-container.
  "${COMPOSE[@]}" exec -T api node -e \
    "fetch('http://127.0.0.1:3001/health').then(async r=>{const j=await r.json();process.exit(r.status===200&&j.checks.database==='ok'?0:1)}).catch(()=>process.exit(1))" ||
    fail "in-container /health not healthy"
  echo "ok   in-container /health 200, database ok"
  local html; html="$(curl -sSk --max-time 15 "$base/")" || fail "dashboard via Caddy did not respond"
  grep -q 'id="root"' <<<"$html" || fail "dashboard HTML via Caddy lacks app root"
  echo "ok   dashboard HTML at https://localhost/"
  ct="$(curl -sSk --max-time 15 -o /dev/null -w '%{http_code} %{content_type}' "$base/widget/pinpoint-widget.js")"
  case "$ct" in "200 "*javascript*) echo "ok   widget via Caddy -> $ct" ;; *) fail "widget: $ct" ;; esac
  local hdrs; hdrs="$(curl -sSkI --max-time 15 "$base/")" || fail "no response headers from Caddy"
  grep -qi '^strict-transport-security:' <<<"$hdrs" || fail "no HSTS header from Caddy"
  echo "ok   HSTS header present"

  step "/metrics is not publicly exposed; token-protected inside"
  # Caddy does not route /metrics to the API, so the public path falls through
  # to the dashboard SPA. It must NOT serve Prometheus data.
  local mbody
  mbody="$(curl -sSk --max-time 15 -H "Authorization: Bearer $METRICS_TOKEN" "$base/metrics" || true)"
  if printf '%s' "$mbody" | grep -q 'http_requests_total\|process_cpu'; then
    fail "/metrics leaked Prometheus data through Caddy"
  fi
  echo "ok   https://localhost/metrics does not expose metrics (even with the token)"
  local probe='fetch("http://127.0.0.1:3001/metrics",{headers:process.env.T?{Authorization:"Bearer "+process.env.T}:{}}).then(r=>{console.log(r.status);process.exit(0)}).catch(()=>process.exit(1))'
  [ "$("${COMPOSE[@]}" exec -T api node -e "$probe")" = 401 ] || fail "in-container /metrics without token should be 401"
  echo "ok   in-container /metrics without token -> 401"
  [ "$("${COMPOSE[@]}" exec -T -e "T=$METRICS_TOKEN" api node -e "$probe")" = 200 ] || fail "in-container /metrics with token should be 200"
  echo "ok   in-container /metrics with bearer token -> 200"

  step "api boot report"
  local logs
  logs="$("${COMPOSE[@]}" logs --no-color api 2>&1)"
  printf '%s' "$logs" | grep -q 'config preflight (exposed deployment)' || fail "api logs lack the preflight boot report"
  echo "ok   preflight boot report present"
  if printf '%s' "$logs" | grep -q 'COOKIE_INSECURE'; then fail "api logs mention COOKIE_INSECURE"; fi
  echo "ok   no COOKIE_INSECURE in api logs"

  step "register -> verify (DB) -> login over https"
  assert_code 201 "register" -X POST -k "$base/api/v1/auth/register" \
    -H 'Content-Type: application/json' -d "$(register_payload)"
  # No mail sink in the prod stack: mark verified directly (as ci-seed-e2e.sh does).
  # EMAIL is generated above (safe characters only), so inline it; psql -c would
  # not interpolate variables anyway.
  # shellcheck disable=SC2016 # $POSTGRES_* must expand inside the container
  echo "update users set verified = true where email = '$EMAIL';" |
    "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null ||
    fail "could not mark user verified"
  local hdrs="$TMP/login.headers"
  [ "$(http_code -k -D "$hdrs" -X POST "$base/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d "$(login_payload)")" = 200 ] || fail "login did not return 200"
  grep -iE '^set-cookie: __Host-fl_session=.*;[[:space:]]*Secure' "$hdrs" >/dev/null ||
    fail "login lacks Secure __Host-fl_session cookie: $(grep -i '^set-cookie' "$hdrs" | sed 's/=[^;]*/=<redacted>/')"
  echo "ok   login 200 with Secure __Host-fl_session cookie"

  smoke_screenshot
}

# Upload a screenshot and fetch it back through Caddy via the signed URL
# (STORAGE_DRIVER=local). Uses the bearer token (CSRF-exempt) from the login body.
smoke_screenshot() {
  local base=https://localhost
  step "screenshot upload + signed-URL fetch through Caddy (local storage)"
  local login token auth pid page ann url png="$TMP/shot.png"
  login="$(curl -sSk --max-time 15 -X POST "$base/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d "$(login_payload)")" || fail "login (bearer) failed"
  token="$(jq -r '.token // empty' <<<"$login")"
  [ -n "$token" ] || fail "login body lacks a bearer token"
  auth="Authorization: Bearer $token"
  # 1x1 PNG
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' |
    base64 -d >"$png"

  local proj
  proj="$(curl -sSk --max-time 15 -X POST "$base/api/v1/projects" -H "$auth" \
    -H 'Content-Type: application/json' -d '{"name":"smoke-shots","urls":["https://example.com/"]}')" ||
    fail "create project failed"
  pid="$(jq -r '.project.id // .id // empty' <<<"$proj")"
  page="$(jq -r '(.project.pages // .pages)[0].url // empty' <<<"$proj")"
  [ -n "$pid" ] && [ -n "$page" ] || fail "project create response unexpected: $proj"

  ann="$(curl -sSk --max-time 15 -X POST "$base/api/v1/projects/$pid/annotations" -H "$auth" \
    -H 'Content-Type: application/json' -d "$(jq -nc --arg u "$page" '{pageUrl:$u,body:"smoke",type:"note",severity:"minor",
      target:{cssSelector:"body",xpath:"/html/body",pageX:1,pageY:1,tagName:"BODY",textSnippet:""},
      environment:{browserFamily:"Chrome",browserVersion:"120.0",osFamily:"macOS",osVersion:"14.0",deviceType:"desktop",userAgentRaw:"smoke"}}')")" ||
    fail "create annotation failed"
  ann="$(jq -r '.annotation.id // empty' <<<"$ann")"
  [ -n "$ann" ] || fail "annotation id missing"

  [ "$(http_code -k -X POST "$base/api/v1/annotations/$ann/screenshot" -H "$auth" -F "image=@$png;type=image/png")" = 200 ] ||
    fail "screenshot upload did not return 200"
  echo "ok   screenshot upload 200"

  url="$(curl -sSk --max-time 15 "$base/api/v1/annotations/$ann/screenshot" -H "$auth" | jq -r '.screenshotUrl // empty')"
  case "$url" in *"/api/v1/screenshots/"*) ;; *) fail "unexpected screenshot url: $url" ;; esac
  echo "ok   signed URL minted"
  # The URL's origin is APP_URL (https://localhost); fetch it WITHOUT credentials.
  local hdrs="$TMP/shot.headers" got="$TMP/shot.fetched"
  [ "$(http_code -k -D "$hdrs" -o "$got" "$url")" = 200 ] || fail "signed URL fetch did not return 200"
  cmp -s "$png" "$got" || fail "fetched screenshot differs from the uploaded bytes"
  grep -qi '^content-type: image/png' "$hdrs" || fail "signed URL is not served as image/png"
  grep -qi '^x-content-type-options: nosniff' "$hdrs" || fail "signed URL lacks nosniff"
  echo "ok   signed URL returns the identical PNG (image/png, nosniff)"
  assert_code 403 "tampered signed URL" -k "${url/\/screenshots\//\/screenshots\/A}"
  # Survives an API restart because it lives on the named volume.
  "${COMPOSE[@]}" restart api >/dev/null
  retry "$TIMEOUT_S" "API health after restart" curl -fsSk "$base/api/v1/health"
  local fresh
  fresh="$(curl -sSk --max-time 15 "$base/api/v1/annotations/$ann/screenshot" -H "$auth" | jq -r '.screenshotUrl // empty')"
  [ "$(http_code -k "$fresh")" = 200 ] || fail "screenshot missing after API restart (volume not persistent?)"
  echo "ok   screenshot persisted across an API restart"
}

"smoke_$MODE"
echo
echo "compose-smoke ($MODE): ALL CHECKS PASSED"
