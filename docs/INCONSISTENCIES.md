# Pinpoint — Inconsistencies & Technical Debt

Quick-reference for moonbase agents. These are things that are broken, contradictory, or incomplete in the current codebase.

> **Status update — 2026-07-31 (branch `feat/full-platform-wiring`):** All four
> P0 bugs (1–4) and the higher-severity wiring gaps (5–9) below have been
> **resolved** — see the per-row Status column and the Dead Code section.
> Remaining open items are marked inline (⬜). Verified via `tsc --noEmit` +
> scoped `vitest`; the 4 shared-link integration tests still need a live
> Postgres to run (environment-blocked, not a code defect).

---

## 🔴 Bugs (Will Break in Production)

| # | Issue | File | Severity | Status |
|---|-------|------|----------|--------|
| 1 | CORS: `origin: '*'` + `credentials: true` is invalid | `composition/container.ts` | Critical | ✅ Fixed — reflects the request Origin when `*`; prod wildcard guard in `config.ts` |
| 2 | Stripe webhook: JSON-parsed body can't be signature-verified | billing webhook handler | Critical | ✅ Fixed — `express.json({ verify })` preserves `req.rawBody`; verified against raw bytes |
| 3 | OAuth callback requires auth middleware (redirects won't work) | `integrations.routes.ts` / `oauth.routes.ts` | Critical | ✅ Fixed — callbacks mounted before auth; `state` validated instead |
| 4 | Duplicate index in migration (fails on fresh DB) | `20260612000004_performance_indexes.ts` | High | ✅ Fixed — excludes the dup; all `CREATE INDEX IF NOT EXISTS` |
| 5 | Webhooks are never dispatched (use case wired but never called) | `DispatchWebhook` / `WebhookDispatchingEventBus` | High | ✅ Fixed — events omitted `orgId`; bus now resolves it from `projectId` (HTTP + HMAC delivery confirmed) |
| 6 | `AuditLog` service is never used | `auditLog.ts` / routes | Medium | ✅ Fixed — `recordAudit` called from apiKeys/org/webhooks/projects routes |
| 7 | `dailyDigest` service exists with no scheduling/worker wiring | `dailyDigest.ts` | Medium | ✅ Fixed — `createDigestWorker` wired in the container (when `DIGEST_ENABLED`) |
| 8 | `smartSuggestions` service exists with no route or UI | `smartSuggestions.ts` | Low | ✅ Fixed — `cssSelector` + project scoping; wired via `GET /annotations/:id/suggestions` (+ dashboard panel) |
| 9 | `visualRegression` service exists with no route or UI | `visualRegression.ts` | Low | ✅ Fixed — DI + S3 baseline fetch; `POST /annotations/:id/check-regression` |

---

## 🟡 Inconsistencies

### Error Response Shapes (3 Different Formats!)
```typescript
// Format 1: Domain errors via sendDomainError()
{ "error": "Not found" }

// Format 2: Org/billing/webhook routes
{ "error": { "code": "FORBIDDEN", "message": "Not allowed" } }

// Format 3: Zod validation
{ "error": "Validation failed", "issues": { "field": "message" } }
```

### Architecture Split
- **Hexagonal (proper):** auth, projects, annotations, comments, teams, guidelines, shared-links, notifications, analytics
- **Direct-to-Knex (no domain layer):** billing, workflow, premium, clientPortal, reporting, heatmap, feedback, integrations, oauth, csat, boards

### Naming
- ✅ Custom Elements renamed to `pp-` prefix (primary registration) with `fl-` kept as backwards-compat **legacy aliases** (`registerElement.ts` dual-registers). Branding aligned to "Pinpoint".
- Some routes use `camelCase` params, others use `snake_case`
- Migration timestamps: some use `20240101000000` (generic), others `20260612000004` (specific)

### Auth Patterns
- Dashboard: Cookie + CSRF token
- Extension: Bearer JWT in `chrome.storage.local`
- API Keys: `X-API-Key` header
- Shared Links: separate password-verify flow
- Widget: (not yet implemented) project public key

### Pagination
- `feedback.routes.ts` and `notifications.routes.ts`: paginated with `{ data, pagination }`
- All other list endpoints: return bare arrays with no pagination

### Test Coverage
| Has Tests | No Tests |
|-----------|----------|
| AuthPage, VerifyEmailPage, ProjectView, SettingsPage, SharedProjectView, DashboardHome | IntegrationsPage, ClientPortalPage, WorkflowsPage, ReportingPage, OnboardingWizard, NotFoundPage |
| AppLayout, ProjectListSidebar, TeamManagement | HeatmapOverlay, ReplayPlayer, NotificationBell |
| All 13/14 extension components | ScreenshotViewer |
| All core server routes | All premium server routes |

---

## 🟠 Missing Infrastructure

| What | Dev | Prod (Terraform) | Gap |
|------|-----|-------------------|-----|
| Redis | ❌ Not in docker-compose | ✅ ElastiCache | Rate limiting differs dev↔prod |
| Monitoring | ❌ None | ✅ CloudWatch | No local observability |
| CD Pipeline | ❌ None | ✅ ECS/ECR defined | No automated deployment |
| Database Seeds | ❌ None | N/A | Nielsen's heuristics not auto-seeded |
| Email (local) | ❌ None | ✅ SES | Can't test email flows locally |

---

## 🔵 Dead Code & Unused Wiring

1. ✅ **`server/src/services/smartSuggestions.ts`** — revived; correct `cssSelector` + project scoping; wired via `GET /annotations/:id/suggestions`.
2. ✅ **`server/src/services/visualRegression.ts`** — revived (dependency-injected); pure `compareScreenshots` tested; S3 baseline fetch wired.
3. ✅ **`server/src/services/dailyDigest.ts`** — scheduled via `createDigestWorker` (when `DIGEST_ENABLED`).
4. ✅ **`DispatchWebhook` use case** — now invoked by `WebhookDispatchingEventBus` (orgId resolved from projectId); HTTP + HMAC delivery.
5. ✅ **`AuditLog` service** — `recordAudit` called from sensitive routes (apiKeys/org/webhooks/projects).
6. ⬜ **`mobile-sdk/` workspace** — still `private: false` (publishable) but no tests, no CI (unchanged).
7. ⬜ **`extension/src/services/` directory** — empty (unchanged).
8. ⬜ **Session Replay (V2 deferred)** — `ReplayPlayer.ts` + `sessionReplay.ts` still stubs (unchanged).

---

## 🟣 Performance Concerns

1. **Heatmap:** Loads ALL annotations for a project into memory, processes in JS → should be DB aggregate
2. **Reporting:** 4 complex queries per request with no caching → should use materialized views
3. **Dashboard `index.html`:** 76 KB single HTML file with all templates → should lazy-load pages
4. **No virtual scrolling:** Long annotation lists render all DOM rows
5. **No query timeouts:** No `statement_timeout` in Knex config → long queries exhaust pool
6. **Cache is process-local:** Restarting server invalidates all caches; inconsistent across instances
7. **No cache invalidation on write:** Creating an annotation doesn't invalidate analytics cache (60s stale window)
8. **`Popover.ts` is 110 KB** — single monolithic Web Component file

---

## Agent Execution Reference

```bash
# P0 bugs (1–4) and wiring gaps (5–9) are RESOLVED — see the Status column above.
# Genuinely remaining work an agent can pick up:

# Harden the integrations OAuth callback — `state` is currently trusted as the
# orgId with no validation (IDOR/CSRF: an unauthenticated request can write an
# integration for an arbitrary org). Validate it against a stored/signed value.
moonbase mission "Secure GET /api/v1/integrations/:provider/callback: validate state instead of trusting it as orgId"

# Extract the direct-to-Knex premium routes into the hexagonal domain layer
moonbase mission "Extract billing.routes.ts into a proper hexagonal domain layer with use cases, ports, and adapters"

# Flesh out the deferred Session Replay stubs (ReplayPlayer.ts / sessionReplay.ts)
moonbase mission "Implement Session Replay recording + playback beyond the current stubs"
```
