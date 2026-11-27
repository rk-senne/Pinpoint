# Load tests

k6 scenarios + a socket.io fan-out script. Results, methodology and fixes are in
[`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md). Everything runs locally for $0.

```bash
# 1. dataset (LOCAL db only; idempotent; loadtest- prefix) + tokens.json
set -a; . $HOME/.pinpoint-dev/env; set +a        # or your own JWT_SECRET / DB_* for the target API
DB_USER=postgres node loadtest/seed.mts           # --scale=0.1 for a small set, --clean to remove
# 2. raise the rate limits for the API under test (env only): API_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_IP_MAX, TENANT_RATE_LIMIT_MAX
# 3. run
k6 run loadtest/scenarios/mixed.js                # 50 users, ~10 rps, 3 min (SLO check)
k6 run loadtest/scenarios/reads.js | writes.js | burst.js | widget.js | stress.js | soak.js | smoke.js
node loadtest/realtime.mjs                        # socket.io fan-out delay
node loadtest/soak-monitor.mjs                    # API RSS/heap sampling (run next to soak.js)
```

- `lib.js` – shared helpers, the request mix (`mixedAction`) and thresholds (reads p95 < 500 ms,
  writes p95 < 800 ms, unexpected errors < 1 %; 429s are counted separately in `pp_rate_limited_429`).
- `.tokens.json` / `.widget-keys.json` (gitignored) hold offline-minted session JWTs (12 h) and
  widget keys. `DEBUG_FAIL=1` prints every unexpected response.
- Env knobs: `BASE_URL`, `VUS`, `DURATION`, `THINK_SECONDS`, `RPS`, `ORGS`, `STEPS`, `STEP_DURATION`,
  `READ_P95_MS`, `WRITE_P95_MS`, `MAX_ERROR_RATE`, `SUMMARY_FILE`.
- CI: `.github/workflows/loadtest.yml` (smoke on PRs/pushes, full suite via workflow_dispatch;
  `loadtest/docker-compose.loadtest.yml` lifts the rate limits for the Compose stack).
