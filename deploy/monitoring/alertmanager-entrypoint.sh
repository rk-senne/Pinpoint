#!/bin/sh
# Render the config from env, then run Alertmanager. POSIX sh (busybox image).
set -eu
dir="$(dirname "$0")"
sh "$dir/render-alertmanager.sh"
exec /bin/alertmanager \
  --config.file="${ALERTMANAGER_OUT_DIR:-/tmp/alertmanager}/alertmanager.yml" \
  --storage.path=/alertmanager \
  --cluster.listen-address= \
  --web.listen-address=:9093
