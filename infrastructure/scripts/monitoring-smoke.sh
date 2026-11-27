#!/usr/bin/env bash
# Boot the PRODUCTION compose stack WITH the `monitoring` profile for real and
# assert the whole alerting pipeline works end to end:
#
#   infrastructure/scripts/monitoring-smoke.sh
#
#   1. every Prometheus scrape target is up, all alert rules are loaded and healthy
#   2. Alertmanager is reachable and the Watchdog alert arrives (dead-man's switch path)
#   3. the exporters deliver what the rules/dashboard need (pg_up, probes, cert expiry,
#      and - when wired in container.ts - the app's own queue / db gauges)
#   4. deploy/backup.sh really runs and its textfile metric reaches Prometheus
#   5. Grafana is provisioned (datasource + dashboard), requires login, and nothing but
#      Caddy / loopback-Grafana publishes a host port
#   6. SYNTHETIC OUTAGE: stop the api container -> the real InstanceDown rule fires
#      within its 2 minute `for:` window, reaches Alertmanager, and an e-mail lands in
#      a throw-away SMTP sink (infrastructure/scripts/monitoring-smoke.compose.yml)
#
# Needs: docker compose v2, curl, jq, openssl. Always tears the stack down
# (`down -v`); on failure it dumps logs and writes them to $SMOKE_LOG_DIR
# (default ./compose-smoke-logs) for CI artifact upload. Mirrors compose-smoke.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${SMOKE_LOG_DIR:-$ROOT/compose-smoke-logs}"
TMP="$(mktemp -d)"
TIMEOUT_S="${SMOKE_TIMEOUT_S:-300}"
ENVF="$TMP/.env.production"
TEXTFILE_DIR="$TMP/textfile"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.prod.yml" -f "$ROOT/infrastructure/scripts/monitoring-smoke.compose.yml"
  --env-file "$ENVF" --profile monitoring)

step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- monitoring smoke FAILED (exit $rc); collecting logs ---" >&2
    mkdir -p "$LOG_DIR"
    "${COMPOSE[@]}" ps -a >"$LOG_DIR/ps-monitoring.txt" 2>&1 || true
    "${COMPOSE[@]}" logs --no-color >"$LOG_DIR/compose-monitoring.log" 2>&1 || true
    "${COMPOSE[@]}" ps -a 2>&1 || true
    "${COMPOSE[@]}" logs --no-color --tail=80 prometheus alertmanager blackbox node-exporter postgres-exporter grafana 2>&1 || true
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

# In-network helpers: Prometheus / Alertmanager publish no host port, so query
# them through the busybox wget in their own containers.
prom_get() { "${COMPOSE[@]}" exec -T prometheus wget -qO- "http://localhost:9090$1"; }
prom_query() { # prom_query EXPR -> JSON
  local enc
  enc="$(jq -rn --arg q "$1" '$q|@uri')"
  prom_get "/api/v1/query?query=$enc"
}
prom_value() { prom_query "$1" | jq -r '.data.result[0].value[1] // empty'; }
# wait_prom_eq <secs> <expr> <expected> <description>: poll until the instant query equals <expected>.
wait_prom_eq() {
  local secs="$1" expr="$2" want="$3" what="$4" end got=""
  end=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$end" ]; do
    got="$(prom_value "$expr" 2>/dev/null || true)"
    [ "$got" = "$want" ] && return 0
    sleep 3
  done
  fail "$what: '$expr' is '$got', expected '$want' after ${secs}s"
}
am_alerts() { "${COMPOSE[@]}" exec -T alertmanager wget -qO- "http://localhost:9093/api/v2/alerts"; }

gen_env() {
  cp "$ROOT/deploy/.env.production.example" "$ENVF"
  set_var() { sed -i.bak "s|^$1=.*|$1=$2|" "$ENVF"; }
  set_var DOMAIN localhost
  set_var JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  set_var OAUTH_STATE_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  set_var INTEGRATION_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  METRICS_TOKEN="$(openssl rand -hex 24)"
  set_var METRICS_TOKEN "$METRICS_TOKEN"
  set_var DB_PASSWORD "$(openssl rand -hex 24)"
  set_var DB_APP_PASSWORD "$(openssl rand -hex 24)"
  set_var ACME_EMAIL smoke@example.test
  set_var SMTP_HOST localhost
  set_var SMTP_FROM no-reply@localhost
  rm -f "$ENVF.bak"
  GRAFANA_PASSWORD="$(openssl rand -hex 16)"
  mkdir -p "$TEXTFILE_DIR"
  chmod 755 "$TEXTFILE_DIR"
  chmod 600 "$ENVF"
  {
    echo "STORAGE_DRIVER=local"
    echo "PINPOINT_SERVER_IMAGE=pinpoint-server:monitoring-smoke"
    echo "PINPOINT_DASHBOARD_IMAGE=pinpoint-dashboard:monitoring-smoke"
    echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_PASSWORD"
    echo "PINPOINT_TEXTFILE_DIR=$TEXTFILE_DIR"
  } >>"$ENVF"
}

EXPECTED_JOBS="alertmanager blackbox blackbox-health blackbox-tls node pinpoint-api postgres prometheus redis"

targets_all_up() {
  local json
  json="$(prom_get '/api/v1/targets?state=active')"
  [ "$(jq -r '[.data.activeTargets[] | select(.health != "up")] | length' <<<"$json")" = 0 ] &&
    [ "$(jq -r '[.data.activeTargets[].labels.job] | unique | join(" ")' <<<"$json")" = "$EXPECTED_JOBS" ]
}

rules_loaded() {
  local want got
  want="$(grep -c '^ *- alert:' "$ROOT/deploy/monitoring/alerts.yml")"
  got="$(prom_get '/api/v1/rules' | jq -r '[.data.groups[].rules[] | select(.type == "alerting" and .health == "ok")] | length')"
  [ "$got" = "$want" ]
}

watchdog_in_alertmanager() { am_alerts | jq -e 'any(.[]; .labels.alertname == "Watchdog")'; }

have_app_metrics() { grep -q startQueueMetrics "$ROOT/server/src/composition/container.ts" 2>/dev/null; }

main() {
  gen_env

  step "docker compose config (prod + monitoring + smoke override)"
  "${COMPOSE[@]}" config -q

  step "docker compose up --build (prod + monitoring profile)"
  "${COMPOSE[@]}" up -d --build

  retry "$TIMEOUT_S" "API health through Caddy" curl -fsSk https://localhost/api/v1/health
  echo "ok   API healthy through Caddy"

  step "Prometheus: all scrape targets up, all rules loaded"
  retry "$TIMEOUT_S" "Prometheus ready" "${COMPOSE[@]}" exec -T prometheus wget -qO- http://localhost:9090/-/ready
  retry "$TIMEOUT_S" "all targets up ($EXPECTED_JOBS)" targets_all_up
  echo "ok   targets up: $EXPECTED_JOBS"
  retry 60 "all alert rules loaded and healthy" rules_loaded
  echo "ok   all $(grep -c '^ *- alert:' "$ROOT/deploy/monitoring/alerts.yml") alert rules loaded (health=ok)"

  step "Alertmanager reachable, Watchdog alert present"
  retry 120 "Watchdog alert in Alertmanager" watchdog_in_alertmanager
  echo "ok   Watchdog reached Alertmanager"
  [ "$(prom_value 'sum(alertmanager_alerts{state="active"})')" != "" ] || fail "Prometheus does not scrape Alertmanager"

  step "exporters deliver the series the rules and dashboard use"
  wait_prom_eq 90 'pg_up' 1 "postgres-exporter cannot reach the DB as pinpoint_app"
  echo "ok   pg_up == 1"
  [ -n "$(prom_value 'pg_settings_max_connections')" ] || fail "pg_settings_max_connections missing"
  [ -n "$(prom_value 'sum(pg_stat_database_numbackends)')" ] || fail "pg_stat_database_numbackends missing"
  echo "ok   postgres connection series present"
  wait_prom_eq 60 'redis_up' 1 "redis-exporter cannot reach redis"
  echo "ok   redis_up == 1"
  wait_prom_eq 150 'probe_success{job="blackbox-health"}' 1 "health probe through Caddy -> API -> DB"
  echo "ok   blackbox health probe through Caddy == 1"
  local left
  left="$(prom_value '(probe_ssl_earliest_cert_expiry{job="blackbox-tls"} - time()) > 0')"
  [ -n "$left" ] || fail "no TLS expiry series from Caddy"
  echo "ok   Caddy certificate expiry visible (${left%.*}s left)"
  [ -n "$(prom_value 'node_memory_MemAvailable_bytes')" ] || fail "node_exporter memory series missing"
  [ -n "$(prom_value 'node_filesystem_avail_bytes{mountpoint="/"}')" ] || fail "node_exporter root filesystem series missing (--path.rootfs mount)"
  echo "ok   node_exporter host series present"
  [ -n "$(prom_value 'http_requests_total')" ] || fail "API http_requests_total missing (bearer scrape)"
  echo "ok   API metrics scraped with the bearer token"
  if have_app_metrics; then
    wait_prom_eq 90 'pinpoint_db_up' 1 "app DB gauge"
    [ -n "$(prom_value 'pinpoint_notifications_pending')" ] || fail "pinpoint_notifications_pending missing"
    [ -n "$(prom_value 'pinpoint_webhook_deliveries_pending')" ] || fail "pinpoint_webhook_deliveries_pending missing"
    echo "ok   app gauges pinpoint_db_up / notification / webhook queue present"
  else
    echo "NOTE: server/src/composition/container.ts does not call startQueueMetrics yet - app gauges not asserted (see docs/MONITORING.md)"
  fi

  step "deploy/backup.sh -> textfile metric -> Prometheus"
  PINPOINT_ENV_FILE="$ENVF" BACKUP_DIR="$TMP/backups" PINPOINT_TEXTFILE_DIR="$TEXTFILE_DIR" \
    bash "$ROOT/deploy/backup.sh"
  [ -s "$TEXTFILE_DIR/pinpoint_backup.prom" ] || fail "backup.sh did not write the textfile metric"
  local b=""
  for _ in $(seq 1 30); do
    b="$(prom_value 'time() - pinpoint_backup_last_success_timestamp_seconds')"
    [ -n "$b" ] && break
    sleep 3
  done
  [ -n "$b" ] || fail "pinpoint_backup_last_success_timestamp_seconds never reached Prometheus"
  awk -v v="$b" 'BEGIN { exit !(v >= 0 && v < 300) }' || fail "backup age looks wrong: ${b}s"
  echo "ok   backup metric visible, age ${b%.*}s (BackupStale stays quiet)"

  step "Grafana provisioned, login required, only Caddy/loopback publish ports"
  local g=http://127.0.0.1:3000
  retry 120 "Grafana /api/health" curl -fsS "$g/api/health"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$g/api/search")" = 401 ] || fail "Grafana allows anonymous API access"
  echo "ok   Grafana requires login (anonymous -> 401)"
  curl -fsS -u "admin:$GRAFANA_PASSWORD" "$g/api/datasources" | jq -e 'any(.[]; .uid == "prometheus" and .type == "prometheus")' >/dev/null ||
    fail "Grafana datasource not provisioned"
  retry 60 "Grafana datasource health" bash -c "curl -fsS -u 'admin:$GRAFANA_PASSWORD' $g/api/datasources/uid/prometheus/health | jq -e '.status == \"OK\"'"
  echo "ok   Prometheus datasource provisioned and healthy"
  curl -fsS -u "admin:$GRAFANA_PASSWORD" "$g/api/dashboards/uid/pinpoint-overview" | jq -e '.dashboard.panels | length > 10' >/dev/null ||
    fail "Pinpoint dashboard not provisioned"
  echo "ok   dashboard pinpoint-overview provisioned"
  local bad
  bad="$(docker ps --filter label=com.docker.compose.project=pinpoint \
    --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' |
    awk '$0 ~ /->/ && $1 != "caddy" && $0 !~ /(^| )127\.0\.0\.1:[0-9]+->/ { print }')"
  [ -z "$bad" ] || fail "unexpected published ports: $bad"
  echo "ok   only Caddy publishes public ports (Grafana/mail sink on 127.0.0.1)"

  step "SYNTHETIC OUTAGE: stop the api -> InstanceDown fires -> Alertmanager -> e-mail"
  "${COMPOSE[@]}" stop api >/dev/null
  local fired=""
  for _ in $(seq 1 $((TIMEOUT_S / 3 + 40))); do
    if am_alerts | jq -e 'any(.[]; .labels.alertname == "InstanceDown" and .labels.job == "pinpoint-api" and .status.state == "active")' >/dev/null 2>&1; then
      fired=1
      break
    fi
    sleep 3
  done
  [ -n "$fired" ] || fail "InstanceDown{job=pinpoint-api} never reached Alertmanager"
  echo "ok   InstanceDown{job=pinpoint-api} is active in Alertmanager"
  prom_query 'ALERTS{alertname="InstanceDown",alertstate="firing",job="pinpoint-api"}' | jq -e '.data.result | length == 1' >/dev/null ||
    fail "Prometheus ALERTS does not show InstanceDown firing"

  local mail=""
  for _ in $(seq 1 60); do
    mail="$(curl -fsS --max-time 10 --get http://127.0.0.1:8025/api/v1/search --data-urlencode 'query=InstanceDown' 2>/dev/null | jq -r '.messages[0].Subject // empty' || true)"
    [ -n "$mail" ] && break
    sleep 3
  done
  [ -n "$mail" ] || fail "no InstanceDown e-mail arrived in the SMTP sink"
  echo "ok   alert e-mail delivered: $mail"

  step "recovery: restart the api, InstanceDown clears"
  "${COMPOSE[@]}" start api >/dev/null
  wait_prom_eq 180 'up{job="pinpoint-api"}' 1 "api target recovery"
  echo "ok   api target recovered"
}

main
echo
echo "monitoring-smoke: ALL CHECKS PASSED"
