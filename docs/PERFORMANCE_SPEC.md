# Performance Enhancements Spec

**Date:** 12 June 2026 | **Status:** Approved  
**Target:** p95 < 200ms at 500 concurrent users (k6 baseline)

---

## Problem Statement

Several API endpoints perform unnecessary work that degrades latency under load:

1. Pagination happens in JavaScript after fetching all rows from Postgres
2. Aggregation queries (heatmap, analytics) recompute on every request with no caching
3. Socket.IO and rate limiting use in-memory state that breaks horizontal scaling
4. N+1 query patterns in member listing
5. No response compression
6. Missing database indexes on hot query paths

---

## Enhancement 1: Database-Level Pagination

### Current Behavior
```typescript
// feedback.routes.ts
const annotations = await annotationRepo.listByProject(projectId, filter);
const paginated = annotations.slice(offset, offset + limit); // ← loads ALL rows first
```

### Target Behavior
```typescript
const { rows, total } = await annotationRepo.listByProject(projectId, { ...filter, limit, offset });
```

### Changes
- `AnnotationRepo.listByProject` — add `limit`, `offset` params, return `{ rows, total }`
- `PgAnnotationRepo.listByProject` — use `LIMIT/OFFSET` in SQL + `COUNT(*) OVER()` window function for total
- `CommentRepo.listByAnnotation` — add pagination (limit default 100)
- `feedback.routes.ts` — pass pagination to repo instead of slicing
- `projects.routes.ts` (annotation list) — same

### Performance Impact
- Before: O(n) memory, O(n) row transfer for all annotations in a project
- After: O(limit) memory, O(limit) row transfer
- Expected improvement: 5-50x on projects with >100 annotations

---

## Enhancement 2: Redis Adapter for Socket.IO + Rate Limiting

### Current Behavior
- Socket.IO uses in-memory adapter (messages don't cross ECS task boundaries)
- `tenantRateLimit.ts` stores buckets in a `Map` (resets on deploy, per-instance only)

### Target Behavior
- Socket.IO uses `@socket.io/redis-adapter` so all instances share pub/sub
- Rate limiter uses Redis INCR + EXPIRE (consistent across instances)

### Changes
- Add `REDIS_URL` env var to config
- `container.ts` — conditionally create Redis client, pass to Socket.IO adapter
- `tenantRateLimit.ts` — add Redis-backed mode (INCR key `rl:{orgId}`, EXPIRE = windowMs)
- Fallback: keep in-memory mode when `REDIS_URL` is not set (dev)

### Performance Impact
- Enables horizontal scaling (2+ ECS tasks)
- Rate limiting becomes consistent (no per-instance bypass)
- WebSocket events reach all connected clients regardless of which task they hit

---

## Enhancement 3: Response Caching Layer

### Current Behavior
- Analytics, guidelines, heatmap recompute on every request
- No cache headers sent

### Target Behavior
- In-memory LRU cache (per-instance) with TTL for hot endpoints
- Cache-Control headers for client-side caching where safe
- Cache invalidation on writes

### Endpoints to Cache

| Endpoint | TTL | Invalidation Trigger |
|----------|-----|---------------------|
| `GET /projects/:id/analytics` | 60s | annotation created/deleted/status changed |
| `GET /projects/:id/heatmap` | 60s | annotation created/deleted |
| `GET /guidelines` | 5min | guideline created |
| `GET /reports/overview` | 5min | — (eventually consistent) |
| `GET /api/v1/docs.json` | 1h | — (static at runtime) |

### Changes
- Create `server/src/middleware/cache.ts` — LRU cache middleware with TTL + invalidation registry
- Apply to specific routes with per-route config
- Add `Cache-Control` headers for client hints
- Emit cache invalidation from relevant use cases via EventBus

### Performance Impact
- Analytics (complex aggregation): 60s cache → 98% fewer DB queries under load
- Guidelines: near-zero DB load after first request
- Expected improvement: 3-10x on cached endpoints

---

## Enhancement 4: N+1 Query Elimination

### Current Behavior
```typescript
// org.routes.ts — GET /api/v1/org/members
const memberships = await membershipRepo.listByOrg(orgId);
const members = await Promise.all(
  memberships.map(async (m) => {
    const user = await userRepo.findById(m.userId); // ← N queries
    return { userId: m.userId, role: m.role, email: user?.email, name: user?.name };
  }),
);
```

### Target Behavior
```typescript
const members = await membershipRepo.listByOrgWithUsers(orgId); // single JOIN query
```

### Changes
- Add `listByOrgWithUsers(orgId)` to MembershipRepo port
- Implement in `PgMembershipRepo` with `JOIN users ON users.id = memberships.user_id`
- Update `org.routes.ts` to use the new method
- Same pattern for `listProjectMembers` if it has N+1

### Performance Impact
- Before: 1 + N queries (N = number of org members)
- After: 1 query with JOIN
- Expected improvement: 10-50x latency on orgs with 10+ members

---

## Enhancement 5: Response Compression

### Current Behavior
- No compression middleware — JSON responses sent uncompressed
- Annotation lists with environment metadata can be 50-200KB

### Target Behavior
- gzip/brotli compression on responses > 1KB
- `Content-Encoding: gzip` header

### Changes
- Add `compression` middleware to Express app in `container.ts`
- Configure threshold: 1024 bytes
- Skip for already-compressed content (screenshots)

### Performance Impact
- JSON compresses 70-90% → 50KB response becomes 5-15KB
- Reduces bandwidth, faster time-to-first-byte on slow connections
- CPU cost is negligible for Node.js at this scale

---

## Enhancement 6: Database Index Additions

### Missing Indexes (Hot Paths)

| Table | Index | Query Pattern |
|-------|-------|--------------|
| `annotations` | `(project_id, status, created_at DESC)` | List annotations with status filter |
| `annotations` | `(org_id, created_at DESC)` | Reporting: 30-day window queries |
| `comments` | `(annotation_id, created_at ASC)` | List comments chronologically |
| `comments` | `(org_id, created_at DESC)` | Reporting: team activity |
| `user_notifications` | `(user_id, created_at DESC)` | List notifications (already partial) |
| `board_posts` | `(board_id, vote_count DESC)` | Public board sorted by votes |
| `automation_rules` | `(org_id, trigger_event, active)` | Rule evaluation on events |

### Changes
- Single migration: `20260612000004_performance_indexes.ts`
- All indexes are CREATE INDEX CONCURRENTLY (non-blocking on production)

### Performance Impact
- Prevents sequential scans on frequently filtered/sorted columns
- Expected: 10-100x improvement on filtered queries over large tables

---

## Implementation Order

1. **Enhancement 6** (indexes) — zero code risk, pure DB improvement
2. **Enhancement 5** (compression) — one-line middleware, instant bandwidth savings
3. **Enhancement 1** (DB pagination) — eliminates the most wasteful pattern
4. **Enhancement 4** (N+1 fix) — simple JOIN, high per-request impact
5. **Enhancement 3** (caching) — biggest absolute gain on hot endpoints
6. **Enhancement 2** (Redis) — enables scaling, requires REDIS_URL in production

---

## Success Metrics

| Metric | Before (estimated) | After (target) |
|--------|-------------------|----------------|
| GET /projects/:id/annotations (100 rows) | ~80ms | ~15ms |
| GET /projects/:id/analytics | ~120ms | ~5ms (cached) |
| GET /org/members (20 members) | ~200ms | ~10ms |
| Response size (annotation list, 50 items) | ~80KB | ~12KB (compressed) |
| Horizontal scaling | ❌ (single instance) | ✅ (multi-instance) |
| k6 p95 at 500 concurrent | ~350ms (estimated) | <200ms (target) |

---

## Rollback Strategy

Each enhancement is independent and backward-compatible:
- Indexes: `DROP INDEX CONCURRENTLY`
- Compression: remove middleware
- Pagination: old signature still works (limit/offset default to all rows)
- Cache: disable via TTL=0 or remove middleware
- Redis: falls back to in-memory when REDIS_URL unset
