#!/bin/sh
# Render the Alertmanager config from environment variables.
#
# Alertmanager does not expand ${ENV}, so this script writes the config (and one
# small file per secret, referenced via *_file fields so secrets never appear in
# the config or in `docker inspect` args) and is the entrypoint's first step.
# POSIX sh: runs in the busybox-based prom/alertmanager image; CI lints it with
# the shell linter and feeds the result to `amtool check-config` for several env sets.
#
# Required:  ALERT_EMAIL_TO, SMTP_HOST            (SMTP_PORT default 587)
# Optional:  SMTP_USER SMTP_PASSWORD ALERT_EMAIL_FROM(default SMTP_FROM)
#            ALERT_SMTP_REQUIRE_TLS (default true; false only for a local mail sink)
#            ALERT_NOTIFY_INFO=true  also notify severity=info alerts
#            ALERT_WEBHOOK_URL       generic JSON webhook (Alertmanager payload)
#            ALERT_NTFY_URL          e.g. https://ntfy.sh/<secret-topic> (ntfy renders the payload)
#            ALERT_DISCORD_WEBHOOK_URL, ALERT_SLACK_WEBHOOK_URL
#            ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID (numeric)
#            HEALTHCHECKS_WATCHDOG_URL  dead-man's switch ping target (Watchdog alert)
# Output:    ALERTMANAGER_OUT_DIR (default /tmp/alertmanager) / alertmanager.yml
set -eu

OUT_DIR="${ALERTMANAGER_OUT_DIR:-/tmp/alertmanager}"
CFG="$OUT_DIR/alertmanager.yml"
umask 077
mkdir -p "$OUT_DIR"

: "${ALERT_EMAIL_TO:?ALERT_EMAIL_TO is required}"
: "${SMTP_HOST:?SMTP_HOST is required}"
SMTP_PORT="${SMTP_PORT:-587}"
FROM="${ALERT_EMAIL_FROM:-${SMTP_FROM:-alerts@localhost}}"
REQUIRE_TLS="${ALERT_SMTP_REQUIRE_TLS:-true}"

# Values are interpolated into YAML double-quoted scalars: reject anything that
# could close the quote or start a new line.
nl='
'
safe() { # safe NAME VALUE
  case "$2" in
    *\"* | *\\* | *"$nl"*)
      echo "render-alertmanager: $1 contains a quote, backslash or newline" >&2
      exit 1
      ;;
  esac
}
safe ALERT_EMAIL_TO "$ALERT_EMAIL_TO"
safe SMTP_HOST "$SMTP_HOST"
safe SMTP_PORT "$SMTP_PORT"
safe SMTP_USER "${SMTP_USER:-}"
safe ALERT_EMAIL_FROM "$FROM"
safe ALERT_TELEGRAM_CHAT_ID "${ALERT_TELEGRAM_CHAT_ID:-}"
case "$REQUIRE_TLS" in true | false) ;; *) echo "ALERT_SMTP_REQUIRE_TLS must be true or false" >&2; exit 1 ;; esac
case "${ALERT_TELEGRAM_CHAT_ID:-0}" in *[!0-9-]*) echo "ALERT_TELEGRAM_CHAT_ID must be numeric" >&2; exit 1 ;; esac

secret_file() { # secret_file NAME VALUE -> path of a 0600 file holding VALUE
  printf '%s' "$2" >"$OUT_DIR/$1"
  printf '%s' "$OUT_DIR/$1"
}

{
  echo "global:"
  echo "  smtp_smarthost: \"$SMTP_HOST:$SMTP_PORT\""
  echo "  smtp_from: \"$FROM\""
  echo "  smtp_require_tls: $REQUIRE_TLS"
  if [ -n "${SMTP_USER:-}" ]; then
    echo "  smtp_auth_username: \"$SMTP_USER\""
    echo "  smtp_auth_password_file: \"$(secret_file smtp_password "${SMTP_PASSWORD:-}")\""
  fi
} >"$CFG.head"

# webhook_configs entries (generic webhook and ntfy share the key).
webhooks=""
if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  webhooks="$webhooks
      - url_file: \"$(secret_file webhook_url "$ALERT_WEBHOOK_URL")\"
        send_resolved: true"
fi
if [ -n "${ALERT_NTFY_URL:-}" ]; then
  # ntfy renders Alertmanager payloads itself via its predefined template.
  webhooks="$webhooks
      - url_file: \"$(secret_file ntfy_url "${ALERT_NTFY_URL}?template=alertmanager")\"
        send_resolved: true"
fi

{
  cat "$CFG.head"
  cat <<'YAML'

route:
  receiver: default
  group_by: [alertname, job]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    # Dead-man's switch: only ever goes to the heartbeat receiver (or nowhere).
    - matchers: [alertname="Watchdog"]
      receiver: watchdog
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 5m
YAML
  if [ "${ALERT_NOTIFY_INFO:-false}" != true ]; then
    echo '    - matchers: [severity="info"]'
    echo '      receiver: blackhole'
  fi
  cat <<'YAML'
    - matchers: [severity="critical"]
      receiver: default
      repeat_interval: 1h

# Narrow, explicit inhibitions only (an `equal: [job]` rule would mis-match
# aggregate alerts that carry no job label). If the API is down or the database
# is unavailable, the API/queue symptoms below are noise.
inhibit_rules:
  - source_matchers: [alertname="InstanceDown", job="pinpoint-api"]
    target_matchers: [alertname=~"Api.*|Notification.*|Webhook.*|QueueMetricsStale"]
  - source_matchers: [alertname="DatabaseUnavailable"]
    target_matchers: [alertname=~"Notification.*|Webhook.*|QueueMetricsStale|PostgresConnectionsNearMax"]

receivers:
  - name: blackhole
  - name: watchdog
YAML
  if [ -n "${HEALTHCHECKS_WATCHDOG_URL:-}" ]; then
    echo "    webhook_configs:"
    echo "      - url_file: \"$(secret_file watchdog_url "$HEALTHCHECKS_WATCHDOG_URL")\""
    echo "        send_resolved: false"
  fi
  echo "  - name: default"
  echo "    email_configs:"
  echo "      - to: \"$ALERT_EMAIL_TO\""
  echo "        send_resolved: true"
  if [ -n "$webhooks" ]; then
    echo "    webhook_configs:$webhooks"
  fi
  if [ -n "${ALERT_DISCORD_WEBHOOK_URL:-}" ]; then
    echo "    discord_configs:"
    echo "      - webhook_url_file: \"$(secret_file discord_url "$ALERT_DISCORD_WEBHOOK_URL")\""
    echo "        send_resolved: true"
  fi
  if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
    echo "    slack_configs:"
    echo "      - api_url_file: \"$(secret_file slack_url "$ALERT_SLACK_WEBHOOK_URL")\""
    echo "        send_resolved: true"
  fi
  if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]; then
    echo "    telegram_configs:"
    echo "      - bot_token_file: \"$(secret_file telegram_token "$ALERT_TELEGRAM_BOT_TOKEN")\""
    echo "        chat_id: $ALERT_TELEGRAM_CHAT_ID"
    echo "        send_resolved: true"
  fi
} >"$CFG"
rm -f "$CFG.head"
echo "render-alertmanager: wrote $CFG" >&2
