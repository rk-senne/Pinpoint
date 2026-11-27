#!/usr/bin/env bash
# Static validation of the whole monitoring configuration. Used by
# .github/workflows/monitoring.yml and runnable locally:
#
#   deploy/monitoring/check.sh
#
# Tools: promtool / amtool / blackbox_exporter on PATH (or in
# $HOME/.pinpoint-dev/bin) are used when present; otherwise the exact pinned
# Docker images below are used (so CI needs no downloads). Needs: bash, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MON="$ROOT/deploy/monitoring"
PROM_IMAGE="prom/prometheus:v3.16.0"
AM_IMAGE="prom/alertmanager:v0.35.1"
BB_IMAGE="prom/blackbox-exporter:v0.29.1"
PATH="$HOME/.pinpoint-dev/bin:$PATH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

docker_run() { # docker_run IMAGE ENTRYPOINT args...
  local image="$1" ep="$2"
  shift 2
  docker run --rm --entrypoint "$ep" -v "$ROOT:$ROOT:ro" -v "$TMP:$TMP" -w "$ROOT" "$image" "$@"
}
promtool() { if type -P promtool >/dev/null; then command promtool "$@"; else docker_run "$PROM_IMAGE" promtool "$@"; fi; }
amtool() { if type -P amtool >/dev/null; then command amtool "$@"; else docker_run "$AM_IMAGE" amtool "$@"; fi; }
blackbox() { if type -P blackbox_exporter >/dev/null; then command blackbox_exporter "$@"; else docker_run "$BB_IMAGE" /bin/blackbox_exporter "$@"; fi; }

step "promtool check rules"
promtool check rules "$MON/alerts.yml"

step "promtool test rules (every alert has a firing test)"
promtool test rules "$MON/tests/alerts.test.yml"

step "every alert has a test case and a runbook section"
python3 - "$MON/alerts.yml" "$MON/tests/alerts.test.yml" "$ROOT/docs/MONITORING.md" <<'PY'
import re, sys
rules, tests, docs = (open(p).read() for p in sys.argv[1:4])
alerts = re.findall(r'^\s*-\s*alert:\s*(\S+)', rules, re.M)
anchors = {re.sub(r'[^a-z0-9 -]', '', h.lower()).strip().replace(' ', '-') for h in re.findall(r'^#{2,4}\s+(.+?)\s*$', docs, re.M)}
bad = []
for a in alerts:
    if not re.search(r'alertname:\s*' + re.escape(a) + r'\s*$', tests, re.M):
        bad.append(f'{a}: no promtool test (alertname: {a})')
    if a.lower() not in anchors:
        bad.append(f'{a}: no "### {a}" section in docs/MONITORING.md')
    if f'docs/MONITORING.md#{a.lower()}' not in rules:
        bad.append(f'{a}: runbook annotation must be docs/MONITORING.md#{a.lower()}')
if not alerts:
    bad.append('no alerts found')
if bad:
    print('\n'.join(bad)); sys.exit(1)
print(f'ok: {len(alerts)} alerts, all tested and documented')
PY

# promtool resolves rule_files / credentials_file relative to the container
# paths in the shipped config; point them at real files for validation.
check_prom_config() { # check_prom_config FILE
  local out
  out="$TMP/$(basename "$(dirname "$1")")-prometheus.yml"
  : >"$TMP/metrics_token"
  sed -e "s#/etc/prometheus/alerts.yml#$MON/alerts.yml#" -e "s#/tmp/metrics_token#$TMP/metrics_token#" "$1" >"$out"
  promtool check config "$out"
}
step "promtool check config (production)"
check_prom_config "$MON/prometheus.yml"
step "promtool check config (dev profile)"
check_prom_config "$ROOT/infrastructure/monitoring/prometheus.yml"

step "alertmanager config renders and passes amtool check-config (env matrix)"
render() { # render NAME VAR=value...  -> $TMP/NAME/alertmanager.yml
  local name="$1"
  shift
  env -i PATH="$PATH" ALERTMANAGER_OUT_DIR="$TMP/$name" "$@" sh "$MON/render-alertmanager.sh" 2>/dev/null
  amtool check-config "$TMP/$name/alertmanager.yml"
}
render email-only ALERT_EMAIL_TO=ops@example.com SMTP_HOST=smtp.example.com
render email-auth ALERT_EMAIL_TO=ops@example.com SMTP_HOST=smtp.example.com SMTP_PORT=465 SMTP_USER=u SMTP_PASSWORD=p ALERT_EMAIL_FROM=am@example.com
render everything ALERT_EMAIL_TO=ops@example.com SMTP_HOST=smtp.example.com SMTP_USER=u SMTP_PASSWORD=p \
  ALERT_NOTIFY_INFO=true ALERT_WEBHOOK_URL=https://hooks.example.com/x ALERT_NTFY_URL=https://ntfy.sh/topic \
  ALERT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/x ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T/B/x \
  ALERT_TELEGRAM_BOT_TOKEN=123:abc ALERT_TELEGRAM_CHAT_ID=-100123 HEALTHCHECKS_WATCHDOG_URL=https://hc-ping.com/uuid \
  ALERT_SMTP_REQUIRE_TLS=false
grep -q 'severity="info"' "$TMP/email-only/alertmanager.yml" || fail "info alerts must be routed to blackhole by default"
if grep -q 'severity="info"' "$TMP/everything/alertmanager.yml"; then fail "ALERT_NOTIFY_INFO=true must not blackhole info alerts"; fi
for k in webhook_configs discord_configs slack_configs telegram_configs; do
  grep -q "$k" "$TMP/everything/alertmanager.yml" || fail "$k missing when its env is set"
  if grep -q "$k" "$TMP/email-only/alertmanager.yml"; then fail "$k present although its env is unset"; fi
done
# Secrets must never be inlined into the config.
if grep -q -e 'hooks.slack.com' -e '123:abc' -e 'smtp_auth_password: ' "$TMP/everything/alertmanager.yml"; then fail "a secret leaked into alertmanager.yml"; fi
echo "ok: secrets are referenced via *_file only"
for bad in 'ALERT_EMAIL_TO=a"b@example.com' 'ALERT_SMTP_REQUIRE_TLS=maybe' 'ALERT_TELEGRAM_CHAT_ID=abc'; do
  if env -i PATH="$PATH" ALERTMANAGER_OUT_DIR="$TMP/bad" ALERT_EMAIL_TO=ops@example.com SMTP_HOST=h "$bad" sh "$MON/render-alertmanager.sh" 2>/dev/null; then
    fail "render-alertmanager accepted invalid input: $bad"
  fi
done
echo "ok: invalid input rejected"

step "blackbox config renders and passes --config.check"
mkdir -p "$TMP/bb"
DOMAIN=pinpoint.example.com BLACKBOX_RENDER_ONLY=1 BLACKBOX_RENDERED="$TMP/bb/blackbox.yml" BLACKBOX_TEMPLATE="$MON/blackbox.tmpl.yml" sh "$MON/blackbox-entrypoint.sh"
grep -q 'server_name: pinpoint.example.com' "$TMP/bb/blackbox.yml" || fail "blackbox DOMAIN not substituted"
if DOMAIN='bad;domain' BLACKBOX_RENDER_ONLY=1 BLACKBOX_RENDERED="$TMP/bb/x.yml" BLACKBOX_TEMPLATE="$MON/blackbox.tmpl.yml" sh "$MON/blackbox-entrypoint.sh" 2>/dev/null; then fail "blackbox accepted a hostile DOMAIN"; fi
blackbox --config.check --config.file="$TMP/bb/blackbox.yml"

step "grafana provisioning + dashboard JSON are well-formed"
python3 - "$MON/grafana" <<'PY'
import json, sys, pathlib
base = pathlib.Path(sys.argv[1])
d = json.loads((base / 'dashboards/pinpoint-overview.json').read_text())
assert d['uid'] == 'pinpoint-overview' and d['panels'], 'dashboard missing uid/panels'
exprs = [t['expr'] for p in d['panels'] for t in p.get('targets', [])]
assert all(p.get('datasource', {}).get('uid') == 'prometheus' for p in d['panels'] if p['type'] != 'row')
print(f"ok: dashboard with {len(d['panels'])} panels / {len(exprs)} queries")
PY

step "images in the compose files are pinned (no :latest, no floating tags) for the monitoring services"
python3 - "$ROOT" <<'PY'
import re, sys
root = sys.argv[1]
bad = []
for f in ('deploy/docker-compose.prod.yml', 'docker-compose.yml'):
    txt = open(f'{root}/{f}').read()
    for svc, body in re.findall(r'^  ([a-z-]+):\n((?:    .*\n|\n)+)', txt, re.M):
        if 'profiles: [monitoring]' not in body:
            continue
        m = re.search(r'image:\s*(\S+)', body)
        if not m or not re.search(r':v?\d+\.\d+\.\d+(-\S+)?$', m.group(1)):
            bad.append(f'{f}: {svc}: {m.group(1) if m else "no image"} is not pinned to an exact version')
if bad:
    print('\n'.join(bad)); sys.exit(1)
print('ok: monitoring images pinned to exact versions')
PY

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  step "docker compose config (prod, monitoring profile)"
  docker compose -f "$ROOT/deploy/docker-compose.prod.yml" --env-file "$ROOT/deploy/.env.production.example" --profile monitoring config -q
  step "docker compose config (dev, monitoring profile)"
  docker compose -f "$ROOT/docker-compose.yml" --profile monitoring config -q
fi

echo
echo "monitoring config checks: ALL PASSED"
