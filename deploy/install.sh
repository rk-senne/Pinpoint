#!/usr/bin/env bash
# One-command installer for Pinpoint on a fresh Ubuntu 22.04 / 24.04 VPS.
#
#   git clone https://github.com/rk-senne/Pinpoint.git /opt/pinpoint
#   sudo /opt/pinpoint/deploy/install.sh
#
# What it does (idempotent - safe to re-run; existing secrets are never replaced):
#   1. installs Docker Engine + the compose plugin from Docker's apt repo (if missing)
#   2. enables ufw for SSH + 80 + 443 (only if ufw is installed; opt out with PINPOINT_SKIP_UFW=1)
#   3. asks for DOMAIN and ADMIN_EMAIL (Let's Encrypt) and, optionally, SMTP settings
#   4. generates every secret with openssl into deploy/.env.production (chmod 600), only if absent
#   5. pulls the GHCR images (builds from source if they cannot be pulled), runs migrations, starts the stack
#   6. waits for https://$DOMAIN/api/v1/health and prints the URL and next steps
#
# Non-interactive: export the answers and set PINPOINT_NONINTERACTIVE=1.
#   DOMAIN            public hostname; its DNS A/AAAA record must already point at this host
#   ADMIN_EMAIL       Let's Encrypt contact (expiry notices)
#   SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM   optional mail settings
#   PINPOINT_BUILD=1  build images from source instead of pulling
#   PINPOINT_SKIP_UFW=1, PINPOINT_FORCE=1 (allow non-Ubuntu / other versions)
#   PINPOINT_MONITORING=1  also enable the free monitoring stack (Prometheus, Alertmanager,
#                          Grafana + exporters; see docs/MONITORING.md): generates the Grafana
#                          admin password and sets COMPOSE_PROFILES=monitoring in the env file
set -euo pipefail

# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

interactive() { [ "${PINPOINT_NONINTERACTIVE:-0}" != 1 ] && [ -t 0 ]; }

# ask VAR "prompt" [default]: keep an exported value, else prompt, else default.
ask() {
  local var="$1" prompt="$2" default="${3:-}" reply
  if [ -n "${!var:-}" ]; then return 0; fi
  if interactive; then
    if [ -n "$default" ]; then
      read -r -p "$prompt [$default]: " reply
      reply="${reply:-$default}"
    else
      read -r -p "$prompt: " reply
    fi
    printf -v "$var" '%s' "$reply"
  else
    printf -v "$var" '%s' "$default"
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || die "run as root (sudo is not available)"
    log "Re-running with sudo"
    exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
  fi
}

check_os() {
  [ -r /etc/os-release ] || die "cannot read /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04 | ubuntu:24.04) ok "Ubuntu ${VERSION_ID}" ;;
    *)
      if [ "${PINPOINT_FORCE:-0}" = 1 ]; then
        warn "unsupported OS ${ID:-?} ${VERSION_ID:-?} (continuing: PINPOINT_FORCE=1)"
      else
        die "supported: Ubuntu 22.04 / 24.04 (found ${ID:-?} ${VERSION_ID:-?}); set PINPOINT_FORCE=1 to try anyway"
      fi
      ;;
  esac
}

# apt-get update that survives an unrelated broken third-party source (e.g. a
# vendor repo returning 403): warn and continue; the install step below fails
# loudly if a package we need really is unavailable.
apt_update() {
  if ! apt-get update -qq; then
    warn "apt-get update reported errors (often an unrelated third-party source); continuing"
  fi
}

install_prereqs() {
  local pkg missing=()
  for pkg in ca-certificates curl gnupg openssl git; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    ok "base packages already installed"
    return
  fi
  log "Installing base packages: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt_update
  apt-get install -y -qq "${missing[@]}" >/dev/null || die "could not install: ${missing[*]}"
}

install_docker() {
  if docker compose version >/dev/null 2>&1; then
    ok "Docker + compose plugin already installed ($(docker --version))"
    return
  fi
  log "Installing Docker Engine from Docker's apt repository"
  # shellcheck disable=SC1091
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt_update
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
  docker compose version >/dev/null || die "docker compose plugin is not working after install"
  ok "installed $(docker --version)"
}

configure_ufw() {
  if [ "${PINPOINT_SKIP_UFW:-0}" = 1 ]; then
    warn "skipping ufw (PINPOINT_SKIP_UFW=1)"
    return
  fi
  if ! command -v ufw >/dev/null; then
    warn "ufw is not installed - make sure your provider firewall allows only 22, 80 and 443"
    return
  fi
  log "Configuring ufw (SSH, 80, 443)"
  local ssh_port
  ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
  ssh_port="${ssh_port:-22}"
  ufw allow "$ssh_port/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null # HTTP/3
  ufw --force enable >/dev/null
  ok "ufw enabled (ssh $ssh_port, 80, 443)"
  warn "note: Docker publishes ports itself and bypasses ufw; only Caddy publishes ports in this stack (80/443)"
}

valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ || "$1" = localhost ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

create_env_file() {
  if [ -f "$ENV_FILE" ]; then
    ok "$ENV_FILE exists - keeping all existing secrets"
    if [ -z "$(env_get ACME_EMAIL)" ]; then
      ask ADMIN_EMAIL "Admin email for Let's Encrypt notices"
      valid_email "${ADMIN_EMAIL:-}" || die "a valid ADMIN_EMAIL is required"
      env_set ACME_EMAIL "$ADMIN_EMAIL"
    fi
    return
  fi

  ask DOMAIN "Public domain (its DNS record must point at this server, e.g. feedback.example.com)"
  valid_domain "${DOMAIN:-}" || die "DOMAIN is required and must be a hostname (got '${DOMAIN:-}')"
  ask ADMIN_EMAIL "Admin email (Let's Encrypt expiry notices)"
  valid_email "${ADMIN_EMAIL:-}" || die "ADMIN_EMAIL is required and must be an email address"
  ask SMTP_HOST "SMTP host for verification / reset emails (blank to configure later)"
  if [ -n "${SMTP_HOST:-}" ]; then
    ask SMTP_PORT "SMTP port" 587
    ask SMTP_SECURE "SMTP implicit TLS (true for port 465, else false)" false
    ask SMTP_USER "SMTP user (blank for none)"
    if [ -z "${SMTP_PASSWORD:-}" ] && [ -n "${SMTP_USER:-}" ] && interactive; then
      read -r -s -p "SMTP password: " SMTP_PASSWORD
      echo
    fi
    ask SMTP_FROM "From address" "no-reply@$DOMAIN"
  fi

  log "Generating secrets into $ENV_FILE"
  umask 077
  cp "$DEPLOY_DIR/.env.production.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  env_set DOMAIN "$DOMAIN"
  env_set ACME_EMAIL "$ADMIN_EMAIL"
  env_set JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  env_set OAUTH_STATE_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  env_set INTEGRATION_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  env_set METRICS_TOKEN "$(openssl rand -hex 24)"
  env_set DB_PASSWORD "$(openssl rand -hex 24)"
  env_set DB_APP_PASSWORD "$(openssl rand -hex 24)"
  if [ -n "${SMTP_HOST:-}" ]; then
    env_set SMTP_HOST "$SMTP_HOST"
    env_set SMTP_PORT "${SMTP_PORT:-587}"
    env_set SMTP_SECURE "${SMTP_SECURE:-false}"
    env_set SMTP_USER "${SMTP_USER:-}"
    env_set SMTP_PASSWORD "${SMTP_PASSWORD:-}"
    env_set SMTP_FROM "${SMTP_FROM:-no-reply@$DOMAIN}"
  else
    env_set SMTP_FROM "no-reply@$DOMAIN"
    SMTP_UNCONFIGURED=1
  fi
  ok "wrote $ENV_FILE (mode 600)"
}

# enable_monitoring: opt-in ($0, self-hosted). Idempotent; never replaces an existing value.
enable_monitoring() {
  [ "${PINPOINT_MONITORING:-0}" = 1 ] || return 0
  log "Enabling the monitoring profile (Prometheus, Alertmanager, Grafana)"
  [ -n "$(env_get GRAFANA_ADMIN_PASSWORD)" ] || env_set GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 16)"
  [ -n "$(env_get ALERT_EMAIL_TO)" ] || env_set ALERT_EMAIL_TO "$(env_get ACME_EMAIL)"
  local profiles
  profiles="$(env_get COMPOSE_PROFILES)"
  case ",$profiles," in
    *,monitoring,*) ;;
    *) env_set COMPOSE_PROFILES "${profiles:+$profiles,}monitoring" ;;
  esac
  ok "monitoring enabled; Grafana is on 127.0.0.1:3000 (SSH tunnel) - see docs/MONITORING.md"
}

main() {
  SMTP_UNCONFIGURED=0
  require_root "$@"
  check_os
  install_prereqs
  install_docker
  configure_ufw
  create_env_file
  enable_monitoring

  local domain
  domain="$(env_get DOMAIN)"
  [ -n "$domain" ] || die "DOMAIN is not set in $ENV_FILE"
  case "$(env_get SMTP_HOST)" in smtp.example.com | '') SMTP_UNCONFIGURED=1 ;; esac

  log "Validating the compose file"
  compose config -q

  pull_or_build

  log "Running database migrations"
  compose run --rm migrate

  log "Starting the stack"
  compose up -d --remove-orphans

  log "Waiting for https://$domain/api/v1/health (the first certificate can take a minute)"
  wait_healthy "$domain" 300 || die "Pinpoint did not become healthy"

  cat <<EOT

$(printf '\033[1;32m')Pinpoint is running.$(printf '\033[0m')

  Dashboard:  https://$domain/
  Secrets:    $ENV_FILE  (mode 600 - back it up somewhere private;
              INTEGRATION_ENCRYPTION_KEY cannot be regenerated)

Next steps
  1. Open https://$domain/auth and register the first account.
EOT
  if [ "$SMTP_UNCONFIGURED" = 1 ]; then
    cat <<EOT
     SMTP is NOT configured, so no verification email will arrive. Either set
     SMTP_HOST/SMTP_USER/SMTP_PASSWORD in $ENV_FILE and run
     'docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d',
     or verify the account by hand:
       docker compose -f $COMPOSE_FILE --env-file $ENV_FILE exec -T db \\
         sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -c "update users set verified = true where email = '"'"'you@example.com'"'"'"'
EOT
  fi
  cat <<EOT
  2. Daily backups (Postgres + screenshots), kept 14 days in $REPO_ROOT/backups:
       ( crontab -l 2>/dev/null; echo '30 2 * * * $DEPLOY_DIR/backup.sh >> /var/log/pinpoint-backup.log 2>&1' ) | crontab -
     Copy the backups directory off this server.
  3. Free monitoring + alerts (set up an external uptime check and a backup heartbeat):
     docs/MONITORING.md  (enable the stack with PINPOINT_MONITORING=1 and re-run this script)
  4. Upgrade later with: $DEPLOY_DIR/upgrade.sh
  5. Screenshots are stored on this server (Docker volume 'screenshots'); no S3
     account is needed. See docs/DEPLOYMENT.md to use S3-compatible storage instead.
EOT
}

main "$@"
exit
