#!/usr/bin/env bash
# Create the verified, pro-plan seed account the Playwright suite logs in with
# (see e2e/global-setup.ts and e2e/README.md "Seeding the account").
#
# Flow: register through the public API -> mark verified in Postgres (the
# verification link is only ever emailed) -> log in once (the first login of a
# verified user provisions the personal org) -> promote that org to `pro` (the
# free plan caps projects at 2).
#
# Env: FL_API_URL, FL_E2E_EMAIL, FL_E2E_PASSWORD, PG* (libpq) for psql.
set -euo pipefail

API="${FL_API_URL:-http://127.0.0.1:3001}"
EMAIL="${FL_E2E_EMAIL:?FL_E2E_EMAIL is required}"
PASSWORD="${FL_E2E_PASSWORD:?FL_E2E_PASSWORD is required}"
PSQL="${PINPOINT_PSQL:-psql}"
DB="${DB_NAME:-pinpoint}"
LOWER_EMAIL=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')

payload() { jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" --arg n "$1" \
  '{email:$e,password:$p} + (if $n == "" then {} else {name:$n} end)'; }
# SQL arrives on stdin: psql only interpolates :'var' there, not with -c.
sql() { "$PSQL" -v ON_ERROR_STOP=1 -v "email=$LOWER_EMAIL" -At -d "$DB"; }

# Register (409/422 on a re-run is fine: the account already exists).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/register" \
  -H 'Content-Type: application/json' -d "$(payload 'E2E Seed')")
echo "register -> HTTP $code"
case "$code" in 2*|409|422) ;; *) echo "unexpected register status" >&2; exit 1;; esac

echo "update users set verified = true where email = :'email';" | sql

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "$(payload '')")
echo "login -> HTTP $code"
[ "$code" = "200" ] || { echo "seed login failed" >&2; exit 1; }

sql <<'SQL'
update organizations set plan = 'pro' where id in (
  select m.org_id from memberships m join users u on u.id = m.user_id where u.email = :'email');
SQL
echo "seed account ready: $LOWER_EMAIL"
