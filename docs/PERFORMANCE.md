# Performance & load testing

Last measured: 2026-11-27, branch `feat/free-hardening`. Everything below was produced locally for $0
(k6 OSS + Node scripts, no hosted services). Nothing here is a production SLO; see
[Capacity estimate](#capacity-estimate-extrapolated) for how far the numbers can be stretched.

## TL;DR

| | Before | After |
|---|---|---|
| Create burst, 60 concurrent users, no think time | **6 req/s, p95 10.1 s, 98.3 % errors** (pool deadlock) | **1,007 req/s, p95 65 ms, 0 % errors** |
| Widget submissions, 20-30 users | 20 % unexpected errors (500s) | 0 % (only designed 429s) |
| Annotation list, project with 30k annotations (EXPLAIN, page 3) | 9.2 ms | 0.045 ms |
| Analytics, project with 30k annotations (Node + DB, median of 15) | 29.3 ms | 11.6 ms |
| Comment list on a 2,700-comment thread | 9.5 ms median | 4.0 ms median |
| 50 users / ~10 req/s baseline | p95 reads 9 ms, writes 12 ms | p95 reads 11 ms, writes 9 ms (unchanged: it was never the problem) |

The headline finding is not slowness at the target load (50 concurrent users is trivially fast) but a
**connection-pool deadlock** that turned any burst of >= 10 simultaneous annotation creations into a
10-60 s outage of every endpoint. It is fixed and guarded by a regression test and a CI smoke.

## Environment

| | |
|---|---|
| Machine | Apple M4 Pro (`machdep.cpu.brand_string`), 14 logical CPUs (`hw.ncpu`), 24 GiB RAM (`hw.memsize` = 25,769,803,776) |
| Software | Node v26.4.0 (API, one process, no cluster), PostgreSQL 18.1 (local, default config), k6 v1.8.3 (sha256-verified release), macOS |
| Topology | k6, API (no Redis: in-memory limiter and socket adapter) and Postgres on the same host over loopback; the API connects as `pinpoint_app` (RLS enforced, pool 2-10) |
| API config for the run | `API_RATE_LIMIT_MAX=100000000`, `AUTH_RATE_LIMIT_IP_MAX=100000`, `TENANT_RATE_LIMIT_MAX=100000` (env only, restored afterwards) |
| Diagnostics | `log_min_duration_statement=100`, `pg_stat_statements` (`track=all`), `track_io_timing=on` (all reverted afterwards) |

Because load generator, API and database share one machine, absolute numbers are optimistic for network
latency and pessimistic for CPU contention; compare before/after, not against the internet.

## Dataset (`node loadtest/seed.mts`)

Inserted directly with SQL, deterministic (`setseed`), idempotent via the `loadtest-` prefix, removable with `--clean`:

- 20 organisations (Pro plan so the free-plan caps do not interfere) x 10 users = 200 users, one known bcrypt password
- 100 projects (5 per org, 2 pages each); project sizes skewed from ~50 to ~990 annotations
- 50,000 annotations: severity (critical 12.5 % / major 25 % / minor 37.5 % / informational 25 %), type, status
  (active 43 % / in progress 14 % / resolved 43 %), browser/OS/device environments, `created_at` spread over 90 days
- 100,000 comments with a heavily skewed thread-length distribution (median 2, max ~2,700)
- 20,000 audit rows, 200 widget keys
- Session JWTs are minted offline with the API's `JWT_SECRET` and the `JwtTokenIssuer` claim set (`userId`, `email`, `orgId`,
  `role`, `tokenVersion`, `sessionStart`), so no login traffic (and no auth limiter) is involved. Written to the gitignored `loadtest/.tokens.json`.

## Scenarios (`loadtest/`)

| File | What | Thresholds |
|---|---|---|
| `scenarios/mixed.js` | 50 VUs x ~1 req / 5 s (~10 req/s), 3 min: 80 % reads (projects, annotation list incl. status filter + pagination, analytics, heatmap, comments, annotation), 20 % writes (annotation create, comment create, status change) | reads p95 < 500 ms, writes p95 < 800 ms, unexpected errors < 1 % |
| `scenarios/reads.js` / `writes.js` | each endpoint class on its own, 50 / 40 VUs | same |
| `scenarios/burst.js` | 60 VUs creating annotations with no think time (pool-starvation detector) | writes p95 < 800 ms, errors < 1 % |
| `scenarios/widget.js` | public `POST /api/v1/widget/feedback` with `X-Project-Key`; 429s counted separately (`pp_rate_limited_429`) | p95 < 800 ms, unexpected errors < 1 % |
| `scenarios/stress.js` | ramping arrival rate, 25 -> 2,000 req/s | reports the breaking point |
| `scenarios/soak.js` + `soak-monitor.mjs` | 10 min at a fixed rate; the monitor samples RSS/heap/event-loop lag from `/metrics` | no error, RSS growth < 50 % |
| `scenarios/smoke.js` | ~95 s mixed + create burst + widget burst for CI (loose thresholds) | env-overridable |
| `realtime.mjs` | N socket.io listeners in 5 project rooms on `/collab`, annotations created over HTTP, delay from request start to receipt | p95 < 500 ms, loss < 1 % |

"Unexpected error" = any response that is not the expected 2xx; 429 is excluded by design and counted on its own.

## Results

### Before / after (same dataset, same machine)

| Scenario | Metric | Before | After |
|---|---|---|---|
| mixed, 50 VUs, 3 min (9.6 req/s) | read p50 / p95 / p99 | 6.2 / 9.3 / 54 ms | 6.4 / 10.9 / 48 ms |
| | write p50 / p95 / p99 | 7.3 / 11.5 / 71 ms | 7.1 / 9.2 / 53 ms |
| | unexpected errors | 0 % | 0 % |
| reads, 50 VUs, 1 min (49 req/s) | p95 / p99 | 8.2 / 42 ms | 8.9 / 29 ms |
| writes, 40 VUs, 40 s (147-196 req/s) | write p95 | 5.3 ms | 4.9 ms |
| | unexpected errors | 0.68 % (pool timeouts) | 0 % |
| **burst, 60 VUs, 20 s** | throughput | **6 req/s** | **1,007 req/s** |
| | write p50 / p95 | 10.06 s / 10.08 s | 59 / 65 ms |
| | unexpected errors | **98.3 %** | **0 %** |
| widget, 20-30 VUs | unexpected errors (excl. 429) | 20 % | 0 % |
| hot comment thread (2,706 comments) | list median | 9.5 ms | 4.0 ms |

The mixed/reads rows are within noise: at the target load the system has two orders of magnitude of headroom,
so the fixes show up in the burst, widget and large-project cases.

### Realtime fan-out (socket.io `/collab`)

| Listeners | Rooms | Creates/s | Deliveries | Loss | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| 200 | 5 | 5 for 60 s | 11,920 | 0 % | 10.4 ms | 12.5 ms | 13.7 ms |
| 1,000 | 5 | 20 for 30 s | 116,600 | 0 % | 9.4 ms | 15.3 ms | **864 ms** |

At 1,000 listeners (200 sockets per event) the p99 stalls are single-threaded fan-out (see risks).

### Stress / breaking point (single Node process, mixed workload)

| Constant arrival rate | Achieved | Read p95 | Write p95 | Dropped |
|---|---|---|---|---|
| 300 req/s | 300 | 4.2 ms | 2.9 ms | 0 |
| 600 req/s | 600 | 4.0 ms | 2.9 ms | 0 |
| 900 req/s | 900 | 4.1 ms | 2.9 ms | 0 |
| 1,200 req/s | 1,200 | 4.5 ms | 3.6 ms | 0 |
| 1,600 req/s | **1,281 (saturated)** | 228 ms | 262 ms | 6,242 |
| 2,000 req/s | 1,281 (saturated) | 229 ms | 262 ms | 14,249 |

The knee is ~1,250 req/s: one Node thread at 100 % CPU, then queueing (latency is bounded by k6's 200 VU cap,
so the 228 ms is a floor, not a ceiling). No errors at any step.

### Soak (10 min, 50 req/s = 30,000 requests)

0 % errors, read p95 8.1 ms, write p95 7.1 ms. API RSS 317 -> 216 MB (peak 400 MB, GC working), heap 160 -> 73 MB,
event-loop lag p99 <= 12.9 ms: no leak signal.

### RLS cost

The API sets `app.current_org_id` / `app.system` on a pooled connection only when its last tenant differs
(`server/src/infrastructure/tenantContext.ts`). With traffic spread over 20 orgs, 1.03 M of 3.6 M statements in the
run were these `set_config` round trips (28 %). Same mixed workload at a 1,600 req/s offered rate:

| Traffic | Sustained throughput | Read p95 |
|---|---|---|
| 1 tenant (no context switches) | 1,570 req/s | 143 ms (just saturated) |
| 20 tenants | 1,284 req/s | 228 ms |

Context switching costs ~18-20 % of peak throughput; the policies themselves add a cheap `org_id = current_setting(...)` filter
to each index scan (negligible in EXPLAIN). At the 10 req/s target it is invisible.

## Slow queries and fixes

With `log_min_duration_statement=100` and `pg_stat_statements`, the only statements over 100 ms before the fixes were
the pool-starvation victims (`update projects set pin_counter ...`, `insert into pages ...` waiting 2 s+ for a connection,
`select * from comments where annotation_id = ...` at 130-150 ms on a 100k-comment thread). After the fixes nothing in the
steady-state run exceeds 100 ms. Top statements by total time after the fixes: heatmap aggregate (2.4 ms mean), analytics
GROUP BY (1.2 ms), project count (0.57 ms), annotation page (0.57 ms) - all index-backed.

| # | Problem (root cause) | Fix | Where |
|---|---|---|---|
| 1 | **Pool deadlock on create.** `insertWithPin` opened a transaction but ran the page lookup/insert and the annotation insert on the *pool*, not the transaction. Each in-flight create therefore held one connection and waited for a second; at >= `DB_POOL_MAX` (10) concurrent creates every connection was held by a waiting transaction and requests failed after the acquire timeout (`KnexTimeoutError`). Same bug in `CreateProject`. It also meant the pin increment and the insert were not atomic (a failed insert burned a pin). | Repos accept an optional `tx`; the use cases pass it. | `server/src/domain/annotation/usecases/createAnnotation.ts:205-246`, `server/src/domain/project/usecases/createProject.ts:107-113`, ports `PageRepo.ts:8-15`, `AnnotationRepo.ts:24`, `ProjectRepo.ts:25`, adapters `PgPageRepo.ts:19,28`, `PgAnnotationRepo.ts:67-68`, `PgProjectRepo.ts:43-53` |
| 2 | **Race on first submission of a new URL.** Page get-or-create was find-then-insert; two concurrent first submissions for the same new URL -> unique violation -> 500 (found by the regression test once #1 was fixed). | `INSERT ... ON CONFLICT (project_id, url) DO NOTHING` then select; idempotent. | `server/src/adapters/outbound/postgres/PgPageRepo.ts:33-52` |
| 3 | **List comments loaded the whole thread twice.** The route called `listComments.execute` (loads every comment, result discarded) only to re-verify the annotation, which `requireAnnotationAccess` had already done, then ran the paginated query. O(thread) work/memory per page view. | Removed the redundant call. | `server/src/adapters/inbound/http/comments.routes.ts:110-123` |
| 4 | **Analytics streamed every annotation row into Node** and counted there (O(project size) wire + heap). | Single SQL `GROUP BY` (<= ~360 groups). 29.3 -> 11.6 ms at 30k annotations; payload no longer grows with the project. | `server/src/adapters/outbound/postgres/PgAnalyticsRepo.ts:44-100` |
| 5 | **Annotation list sorted the whole project per page** (`ORDER BY pin_number LIMIT/OFFSET`, no matching index). 9.2 ms -> 0.045 ms (page 3) and 4.7 -> 0.034 ms (status filter) at 30k annotations; the gap grows linearly with project size. | New indexes `(project_id, pin_number)` and `(project_id, status, pin_number)`, `CREATE INDEX IF NOT EXISTS`. | `server/src/migrations/20261127150001_annotations_pin_order_indexes.ts` |

Regression tests (real Postgres as `pinpoint_app`, skipped automatically when unreachable):
`server/src/__tests__/integration/connectionPoolStarvation.test.ts` (12 concurrent creates on a pool of 3; verified to fail
with `KnexTimeoutError` when the `tx` plumbing is removed), `commentsListPagination.test.ts`, `analyticsAggregate.test.ts`,
`annotationPinIndexes.test.ts`. The CI smoke (`scenarios/smoke.js`) also contains a create burst that catches a regression of #1.

## Capacity estimate (extrapolated)

**Extrapolated, not measured.** Measured on an Apple M4 Pro, where the API (one Node process) saturates at ~1,250 req/s of the
mixed workload with Postgres on the same machine. A 2 vCPU / 4 GB cloud VPS runs the API and Postgres (and Caddy/Redis) on two
shared vCPUs that are typically 2-3x slower per thread than an M4 Pro core, so plan on roughly **250-500 req/s peak** for one
API process, with the second vCPU mostly serving Postgres. Using the baseline of ~0.2 req/s per active user (one request every
5 s), that is on the order of **1,000-2,000 concurrently active users** before latency leaves the SLO, and far more registered
users. Memory is not the constraint: the soak peaked at 400 MB RSS for the API; 4 GB leaves ample room for Postgres
`shared_buffers` and the OS cache. Validate by running `loadtest/` against a staging VPS (`BASE_URL`, `--scale`) before
quoting a number to customers.

## Remaining risks

- **Single-threaded API.** One slow synchronous task (large export, big JSON) blocks every request; socket fan-out to
  hundreds of sockets per event shows as p99 stalls (864 ms at 1,000 listeners). Run 2+ API processes (the Redis adapter for
  Socket.IO and the Redis rate limiter already support it) before scaling up; not load-tested here.
- **RLS context switching** costs ~20 % peak throughput on multi-tenant traffic (one extra `set_config` round trip per
  connection hand-off). Possible mitigation: tenant-affine pool selection or batching the GUC set with the first query.
  Not done: it is invasive and invisible at target load.
- **O(n) per request remains** for `count(*)` per project list page, the heatmap aggregate (2.4 ms mean, scans the project) and
  `LIMIT/OFFSET` on very deep pages. Fine up to tens of thousands of annotations per project; revisit with keyset pagination /
  cached counts beyond that.
- **Rate limiting was disabled by env for the runs.** Real clients behind one IP hit the 100 requests / 15 min API limit
  quickly; this is a deliberate abuse control, not a performance issue, but test results do not include its cost.
- **Pool size 10** is the default; with fix #1 a create needs one connection, but long transactions + a burst can still
  queue. Watch `pg_stat_activity` and consider `DB_POOL_MAX` ~ 20 on a dedicated database.
- Numbers are loopback, warm cache, single node, 100k-row tables: no network latency, no cold disk, no replication, no noisy neighbours.
- The CI smoke runs against the Compose stack (Docker); local Docker Desktop was unavailable here, so the workflow itself
  was validated with `actionlint` and its steps individually, but not executed on a GitHub runner.

## Re-running

```bash
set -a; . $HOME/.pinpoint-dev/env; set +a            # or your own JWT_SECRET / DB_* for the target stack
DB_USER=postgres node loadtest/seed.mts               # dataset + tokens (node >= 22.18); --scale=0.1 smaller; --clean removes it
$HOME/.pinpoint-dev/stack.sh restart-api              # with API_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_IP_MAX / TENANT_RATE_LIMIT_MAX raised
k6 run loadtest/scenarios/mixed.js                    # the SLO check (also: npm run test:load)
k6 run --env RPS=1200 --env DURATION=20s loadtest/scenarios/soak.js   # fixed-rate steps for the stress curve
node loadtest/realtime.mjs                            # socket.io fan-out
node loadtest/seed.mts --clean                        # tidy up
```

Slow-query diagnosis: `ALTER SYSTEM SET log_min_duration_statement = 100` (+ `pg_stat_statements` via
`shared_preload_libraries`, restart required), then `EXPLAIN (ANALYZE, BUFFERS)` as `pinpoint_app` after
`select set_config('app.current_org_id', '<org uuid>', false)`. CI: `.github/workflows/loadtest.yml` (smoke on every
PR/push to `main`; full suite from *Actions -> Load test -> Run workflow*). See also `loadtest/README.md`.
