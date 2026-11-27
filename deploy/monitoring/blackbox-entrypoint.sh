#!/bin/sh
# Render blackbox.tmpl.yml with $DOMAIN, then exec blackbox_exporter.
# POSIX sh: runs inside the busybox-based prom/blackbox-exporter image.
set -eu
: "${DOMAIN:?DOMAIN is required}"
# DOMAIN is a hostname (validated by deploy/install.sh); refuse anything that
# could break out of the sed expression.
case "$DOMAIN" in
  *[!A-Za-z0-9.-]* | '') echo "invalid DOMAIN '$DOMAIN'" >&2; exit 1 ;;
esac
out="${BLACKBOX_RENDERED:-/tmp/blackbox.yml}"
sed "s/__DOMAIN__/$DOMAIN/g" "${BLACKBOX_TEMPLATE:-/etc/blackbox/blackbox.tmpl.yml}" >"$out"
if [ "${BLACKBOX_RENDER_ONLY:-0}" = 1 ]; then exit 0; fi
exec /bin/blackbox_exporter --config.file="$out"
