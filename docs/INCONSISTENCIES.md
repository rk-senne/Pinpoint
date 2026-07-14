# Pinpoint — Inconsistencies & Technical Debt

Quick-reference for moonbase agents. These are things that are broken, contradictory, or incomplete in the current codebase.

---

## 🔴 Bugs (Will Break in Production)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 1 | CORS: `origin: '*'` + `credentials: true` is invalid | `server/src/index.ts` | Critical |
| 2 | Stripe webhook: JSON-parsed body can't be signature-verified | billing webhook handler | Critical |
| 3 | OAuth callback requires auth middleware (redirects won't work) | `integrations.routes.ts` | Critical |
| 4 | Duplicate index in migration (fails on fresh DB) | `20260612000004_performance_indexes.ts` | High |
| 5 | Webhooks are never dispatched (use case wired but never called) | `DispatchWebhook` use case | High |
| 6 | `AuditLog` service is never used (table exists, service exists, nothing calls it) | `auditLog.ts` / `container.ts` | Medium |
| 7 | `dailyDigest` service exists with no scheduling/worker wiring | `dailyDigest.ts` | Medium |
| 8 | `smartSuggestions` service exists with no route or UI | `smartSuggestions.ts` | Low |
| 9 | `visualRegression` service exists with no route or UI | `visualRegression.ts` | Low |

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
- Custom Elements use `fl-` prefix (legacy "FeedbackLoop" branding) — product is now "Pinpoint"
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

1. **`server/src/services/smartSuggestions.ts`** — AI suggestion service, never imported
2. **`server/src/services/visualRegression.ts`** — visual diff service, never imported
3. **`server/src/services/dailyDigest.ts`** — digest email service, never scheduled
4. **`DispatchWebhook` use case** — wired in container, never called from event handlers
5. **`AuditLog` service** — instantiated nowhere
6. **`mobile-sdk/` workspace** — has `private: false` (publishable) but no tests, no CI
7. **`extension/src/services/` directory** — empty (0 files)
8. **Session Replay (V2 deferred)** — `ReplayPlayer.ts` + `sessionReplay.ts` exist as stubs

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
# Fix all P0 bugs
moonbase mission "Fix BUG-001 through BUG-004 from docs/INCONSISTENCIES.md"

# Standardize error responses
moonbase mission "Standardize all API error responses to { error: { code, message, details? } } format — see docs/INCONSISTENCIES.md"

# Wire dead services
moonbase mission "Wire AuditLog service into sensitive route handlers and expose GET /api/v1/org/audit-log endpoint"

# Fix architecture split
moonbase mission "Extract billing.routes.ts into proper hexagonal domain layer with use cases, ports, and adapters"
```
