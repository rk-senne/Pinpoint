#!/usr/bin/env bash
# OWASP ZAP baseline (passive) scan of the production stack on https://localhost.
#
#   infrastructure/scripts/zap-baseline.sh
#
# Boots deploy/docker-compose.prod.yml with throwaway secrets (same as
# compose-smoke.sh prod), spiders the dashboard and API surface for a few
# minutes, and fails on any WARN/FAIL-level alert that is not listed with a
# reason in infrastructure/scripts/zap-rules.tsv. Reports go to ./zap-report.
# Free: OWASP ZAP is Apache-2.0; image pinned by digest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT_DIR="$ROOT/zap-report"
TMP="$(mktemp -d)"
ZAP_IMAGE="zaproxy/zap-stable:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.prod.yml" --env-file "$TMP/.env.production")

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    "${COMPOSE[@]}" ps -a 2>&1 || true
    "${COMPOSE[@]}" logs --no-color --tail=100 2>&1 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

f="$TMP/.env.production"
cp "$ROOT/deploy/.env.production.example" "$f"
set_var() { sed -i.bak "s|^$1=.*|$1=$2|" "$f"; }
set_var DOMAIN localhost
set_var JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
set_var OAUTH_STATE_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
set_var INTEGRATION_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
set_var METRICS_TOKEN "$(openssl rand -hex 24)"
set_var DB_PASSWORD "$(openssl rand -hex 24)"
set_var DB_APP_PASSWORD "$(openssl rand -hex 24)"
set_var ACME_EMAIL zap@example.test
set_var SMTP_HOST localhost
set_var SMTP_FROM no-reply@localhost
rm -f "$f.bak"
chmod 600 "$f"
{
  echo "STORAGE_DRIVER=local"
  echo "PINPOINT_SERVER_IMAGE=pinpoint-server:zap"
  echo "PINPOINT_DASHBOARD_IMAGE=pinpoint-dashboard:zap"
} >>"$f"

echo "==> booting the production stack"
"${COMPOSE[@]}" up -d --build
end=$((SECONDS + 300))
until curl -fsSk --max-time 5 https://localhost/api/v1/health >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$end" ] || fail "stack did not become healthy"
  sleep 3
done
echo "ok   https://localhost is healthy"

mkdir -p "$REPORT_DIR"
chmod 777 "$REPORT_DIR"
cp "$ROOT/infrastructure/scripts/zap-rules.tsv" "$REPORT_DIR/rules.tsv"

echo "==> ZAP baseline scan"
# -I: don't fail on WARN by itself; we decide below from the JSON report so
# every accepted alert must be listed in zap-rules.tsv with a reason.
set +e
docker run --rm --network host -v "$REPORT_DIR:/zap/wrk:rw" -t "$ZAP_IMAGE" \
  zap-baseline.py -t https://localhost/ -c rules.tsv -m 3 -I -j \
  -J report.json -r report.html -w report.md \
  -z "-config connection.sslAcceptAll=true"
zap_rc=$?
set -e
[ -f "$REPORT_DIR/report.json" ] || fail "ZAP produced no report (exit $zap_rc)"

# Alerts at Medium/High risk that are not IGNOREd in rules.tsv fail the build.
node - "$REPORT_DIR/report.json" "$ROOT/infrastructure/scripts/zap-rules.tsv" <<'NODE'
const fs = require('fs');
const [report, rules] = process.argv.slice(2);
const ignored = new Set(
  fs.readFileSync(rules, 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter(([, action]) => action === 'IGNORE')
    .map(([id]) => id),
);
const alerts = JSON.parse(fs.readFileSync(report, 'utf8')).site.flatMap((s) => s.alerts ?? []);
const bad = alerts.filter((a) => Number(a.riskcode) >= 2 && !ignored.has(String(a.pluginid)));
for (const a of alerts) console.log(`${a.riskdesc.padEnd(22)} ${a.pluginid}  ${a.name} (${a.count} instance(s))${ignored.has(String(a.pluginid)) ? '  [accepted]' : ''}`);
if (bad.length) {
  console.error(`\nFAIL: ${bad.length} Medium/High ZAP alert(s) not accepted in zap-rules.tsv`);
  process.exit(1);
}
console.log('\nok   no unaccepted Medium/High alerts');
NODE
