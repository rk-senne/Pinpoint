# Pinpoint 10x Enhancement Plan

## Mission Brief

This document defines the work required to elevate Pinpoint from a functional MVP to a polished, production-grade 10x product. It is structured as agent-executable missions — each section is a self-contained task package that moonbase agents can pick up and complete.

---

## Critical Bugs (P0 — Fix Immediately)

### BUG-001: CORS Wildcard + Credentials Invalid
**File:** `server/src/index.ts`
**Issue:** `cors({ origin: '*', credentials: true })` is invalid per CORS spec. Browsers reject `Access-Control-Allow-Origin: *` when `credentials: true`.
**Fix:** Change to explicit origin(s) from env var. In dev, use `http://localhost:5173`. In prod, use the actual dashboard domain.

### BUG-002: Stripe Webhook Signature Verification Broken
**File:** `server/src/adapters/inbound/workers/` (billing webhook handler)
**Issue:** Express JSON middleware parses the body before the signature check. Stripe requires the raw body for signature verification.
**Fix:** Add `express.raw({ type: 'application/json' })` middleware on the webhook route BEFORE the global JSON parser, or use `req.rawBody` pattern.

### BUG-003: OAuth Callback Route Requires Auth
**File:** `server/src/adapters/inbound/http/integrations.routes.ts`
**Issue:** `GET /api/v1/integrations/:provider/callback` is behind auth middleware, but OAuth providers redirect unauthenticated users to this URL.
**Fix:** Move the callback route before the auth middleware, validate the state param (which should contain a session reference) instead.

### BUG-004: Duplicate Index Migration
**File:** `server/src/migrations/20260612000004_performance_indexes.ts`
**Issue:** Redefines `idx_comments_annotation_created` which already exists in `20240101000000_initial_schema.ts`. Will fail on fresh database migration.
**Fix:** Add `IF NOT EXISTS` or drop-first-then-create pattern, or remove the duplicate.

---

## Phase A: API Consistency & Reliability

### MISSION-A1: Standardize Error Response Shape
**Scope:** All 26 route files in `server/src/adapters/inbound/http/`
**Problem:** Three different error formats coexist (`{ error: "string" }`, `{ error: { code, message } }`, `{ error: "string", issues }`)
**Target State:** ALL error responses must follow:
```json
{
  "error": {
    "code": "SNAKE_UPPER_CASE",
    "message": "Human readable description",
    "details": {}
  }
}
```
**Tasks:**
1. Refactor `sendDomainError()` in `errors.ts` to emit the standard shape
2. Refactor `sendZodFailure()` to put validation issues inside `details`
3. Update all manual error responses in org, billing, workflow, premium, portal, reporting, heatmap routes
4. Update the global error handler
5. Add a shared `ApiError` type to `@pinpoint/shared`
6. Update all client-side error parsing in dashboard and extension

### MISSION-A2: Add Pagination to All List Endpoints
**Scope:** `projects.routes.ts`, `annotations.routes.ts`, `comments.routes.ts`, `teams.routes.ts`, `org.routes.ts`, `webhooks.routes.ts`, `apiKeys.routes.ts`, `integrations.routes.ts`
**Pattern:**
```typescript
// Request: ?page=1&pageSize=25&sort=createdAt:desc
// Response envelope:
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 25,
    "total": 142,
    "totalPages": 6
  }
}
```
**Tasks:**
1. Create shared `paginationSchema` (Zod) and `PaginatedResponse<T>` type
2. Add `parsePagination(req)` helper middleware
3. Update all repos to accept `{ limit, offset, sortBy, sortDir }` params
4. Update all route handlers to pass pagination through
5. Update dashboard stores to handle paginated responses
6. Add "load more" or page navigation to all list views

### MISSION-A3: Add Input Validation to Unvalidated Routes
**Scope:** See table below
**Routes missing Zod validation:**
- `PATCH /api/v1/org` — validate `name`, `slug`
- `PATCH /api/v1/org/members/:userId` — validate `role` with Zod enum
- `POST /api/v1/org/switch` — validate `orgId` as UUID
- `POST /api/v1/org/invitations` — validate `email` + `role`
- `POST /api/v1/billing/checkout` — validate URLs (prevent SSRF)
- `POST /api/v1/boards` — full Zod schema
- `POST /api/v1/csat/request` — validate `annotationId`
- `POST /api/v1/approvals/workflows` — full schema
- `POST /api/v1/approvals/start` — full schema
- `POST /api/v1/integrations/:provider/connect` — validate `accessToken`
- `GET /api/v1/projects/:id/heatmap` — validate `pageUrl`
- ALL `req.params.id` in newer routes — UUID format validation middleware

### MISSION-A4: Wire Audit Log
**Scope:** `server/src/services/auditLog.ts` + new route + existing routes
**Problem:** The `AuditLog` service and `audit_logs` table exist but are never used.
**Tasks:**
1. Import `AuditLog` service into the composition container
2. Wire it into sensitive route handlers: role changes, project deletion, API key CRUD, org settings, webhook CRUD, billing actions
3. Create `GET /api/v1/org/audit-log?page=1&pageSize=50&action=&actor=&dateFrom=&dateTo=` endpoint
4. Add UI in dashboard SettingsPage → Audit Log tab

### MISSION-A5: Complete API Documentation
**Scope:** `server/src/adapters/inbound/http/apiDocs.ts`
**Problem:** Only 7 of 60+ endpoints are registered with `doc()`.
**Tasks:**
1. Register ALL endpoints with the `doc()` system
2. Add request/response example schemas using Zod-to-JSONSchema
3. Serve Swagger UI at `/api/v1/docs`
4. Add authentication documentation
5. Add rate limit documentation per endpoint group

---

## Phase B: UX & Frontend Polish

### MISSION-B1: Responsive Dashboard Layout
**Scope:** `dashboard/src/components/AppLayout.ts`, `dashboard/src/pages/*.ts`
**Problem:** Dashboard is completely broken on mobile — 260px fixed sidebar, no breakpoints.
**Tasks:**
1. Add CSS breakpoints (`@media (max-width: 768px)`) to AppLayout
2. Add hamburger menu toggle for sidebar on mobile
3. Convert annotation tables to card layouts on small screens
4. Ensure all touch targets are minimum 44×44px
5. Add responsive grid for project cards
6. Make kanban board scroll horizontally on mobile with touch support
7. Test on 375px, 768px, 1024px, 1440px viewpoints

### MISSION-B2: Skeleton Screens & Loading States
**Scope:** All dashboard pages
**Problem:** Every loading state shows plain "Loading…" text.
**Tasks:**
1. Create a `SkeletonLoader` component (pulse animation, configurable shapes)
2. Replace "Loading…" in DashboardHome with card skeletons
3. Replace "Loading…" in ProjectView with list/kanban skeletons
4. Add skeleton for SettingsPage sections
5. Add loading spinner on buttons during submission (prevent double-clicks)
6. Add progress bar for exports/uploads
7. Implement stale-while-revalidate in stores (show cached data + refresh indicator)

### MISSION-B3: Search, Filter & Sort in ProjectView
**Scope:** `dashboard/src/pages/ProjectView.ts`
**Problem:** No filtering/sorting/searching of annotations within a project.
**Tasks:**
1. Add filter bar above annotation list: severity dropdown, status dropdown, assignee dropdown, type dropdown, date range picker
2. Add sort selector: newest, oldest, severity (high→low), pin number
3. Add search input for annotation text/description
4. Persist filter state in URL query params (`?severity=critical&status=active&sort=newest`)
5. Update API to pass filter/sort params (after MISSION-A2 lands)
6. Add empty state when filters produce no results
7. Add "Clear filters" action

### MISSION-B4: Bulk Actions
**Scope:** `dashboard/src/pages/ProjectView.ts` + new API endpoints
**Tasks:**
1. Add checkboxes to annotation list items
2. Add "Select all visible" checkbox in header
3. Show floating action bar when items selected: "Change Status", "Assign To", "Delete"
4. Create `POST /api/v1/projects/:id/annotations/bulk` endpoint accepting `{ ids: [], action: 'resolve'|'archive'|'delete'|'assign', params: {} }`
5. Add keyboard shortcut `X` to toggle selection, `Shift+Click` for range select

### MISSION-B5: Dark Mode
**Scope:** `shared/src/theme.ts`, `dashboard/src/styles/`, all component inline styles
**Problem:** Only the extension has a `@media (prefers-color-scheme: dark)` block. Dashboard has hardcoded light colors.
**Tasks:**
1. Define dark theme CSS custom properties in `shared/src/theme.ts`
2. Replace ALL hardcoded color values in dashboard pages/components with CSS variables
3. Add `@media (prefers-color-scheme: dark)` root variable overrides
4. Add manual theme toggle in Settings (light/dark/system)
5. Persist preference in localStorage
6. Ensure severity colors maintain WCAG contrast in both modes
7. Test all pages in dark mode

### MISSION-B6: Toast Notifications & Action Feedback
**Scope:** New `dashboard/src/components/Toast.ts` + all action handlers
**Problem:** Successful actions have no visible feedback. Errors are inconsistently shown.
**Tasks:**
1. Create a `Toast` component (success/error/warning/info variants, auto-dismiss)
2. Add toast on: project created, annotation resolved, comment posted, settings saved, team member invited, export completed
3. Add toast on: all API errors with retry action where applicable
4. Position toasts in bottom-right stack
5. Add "Undo" action on destructive toasts (delete, archive)

### MISSION-B7: Accessibility Fixes
**Scope:** All dashboard pages and components
**Tasks:**
1. Add visible `:focus-visible` indicators to all interactive elements
2. Add `prefers-reduced-motion` media query — disable transitions when active
3. Add `role="navigation"` to sidebar, `aria-current="page"` to active item
4. Add `role="dialog"` + `aria-modal` + focus trap to all modals
5. Add keyboard alternative for kanban drag-and-drop (Move to Column button)
6. Add shape/icon indicators alongside severity colors (▲ ● ◆ ○)
7. Add `aria-describedby` linking form inputs to their error messages
8. Add `role="menu"` and keyboard navigation to notification dropdown

### MISSION-B8: Empty States with Illustrations
**Scope:** All dashboard pages that render lists/grids
**Tasks:**
1. Design/create SVG illustrations for each empty state
2. Add descriptive empty state to: project annotation list, team members, integrations, notifications, search results, kanban columns, comment threads, audit log, client portals, workflows
3. Each empty state should have: illustration, description text, primary CTA button
4. Add "first use" contextual guidance where appropriate

---

## Phase C: Product Feature Gaps

### MISSION-C1: Embeddable Feedback Widget
**Problem:** Pinpoint only works as a Chrome Extension. Competitors offer a JS snippet that any website can embed for end-user feedback collection.
**Scope:** New `widget/` workspace
**Tasks:**
1. Create `widget/` workspace with a lightweight (<30 KB gzipped) vanilla JS bundle
2. Widget provides a floating feedback button (configurable position)
3. On click, shows a form: description, severity, screenshot (optional)
4. Auto-captures page URL, viewport size, browser info
5. Submits to `POST /api/v1/feedback/widget` (public, rate-limited, requires project API key)
6. Build as a single `pinpoint-widget.js` file served from CDN
7. Add embed code generator to dashboard project settings
8. No auth required — widget uses project-specific public key

### MISSION-C2: Custom Tags/Labels
**Scope:** Schema + API + Extension + Dashboard
**Tasks:**
1. Migration: `tags` table (`id, project_id, name, color, created_at`) + junction `annotation_tags`
2. `POST /api/v1/projects/:id/tags` — CRUD for project tags
3. `PATCH /api/v1/annotations/:id/tags` — add/remove tags
4. Add tag pills to annotation list items in dashboard
5. Add tag selector to extension popover (multi-select chip input)
6. Add tag filter in ProjectView filter bar

### MISSION-C3: Global Search
**Scope:** New search endpoint + dashboard UI
**Tasks:**
1. Create `GET /api/v1/search?q=&type=annotation|project|comment&limit=10`
2. Add PostgreSQL full-text search (`tsvector` + `GIN` index) on annotation description, comment body, project name
3. Add `Ctrl+K` / `Cmd+K` command palette in dashboard
4. Show results grouped by type with highlighting
5. Navigate to result on selection

### MISSION-C4: Activity Feed / Timeline
**Scope:** New domain + route + UI
**Tasks:**
1. Create `activity_events` table (`id, project_id, actor_id, action, resource_type, resource_id, metadata, created_at`)
2. Record events on: annotation create/update/resolve/delete, comment create, member join/leave, status changes, assignment changes
3. Create `GET /api/v1/projects/:id/activity?page=1` endpoint
4. Add Activity tab in ProjectView (timeline with avatar + action + timestamp)
5. Add "Activity" tab to individual annotation detail view

### MISSION-C5: Guest/Anonymous Feedback Mode
**Scope:** Shared links enhancement
**Tasks:**
1. Extend shared link to allow annotation creation (not just viewing)
2. Add "Allow feedback" toggle when creating a shared link
3. Guest users provide name + email (no registration required)
4. Guest annotations are marked with a badge in the annotation list
5. Rate limit guest submissions per IP (5/hour)
6. Send email notification to project owner when guest feedback arrives

---

## Phase D: Infrastructure & Operations

### MISSION-D1: Redis for Production Parity
**Scope:** Rate limiting, caching, session store
**Tasks:**
1. Add Redis to docker-compose.yml for dev
2. Add `ioredis` dependency to server
3. Replace in-memory rate limit store with Redis-backed store
4. Replace in-memory LRU cache with Redis cache (with TTL)
5. Add Redis health check to `/api/v1/health`
6. Add connection retry/fallback logic

### MISSION-D2: Enhanced Health & Readiness
**Scope:** `server/src/` health endpoints
**Tasks:**
1. Split into `/health/live` (basic) and `/health/ready` (full dependency check)
2. Add checks for: PostgreSQL, Redis, S3 connectivity, SMTP (optional)
3. Add build info: commit SHA, build time, version from package.json
4. Add uptime and memory usage metrics
5. Return degraded status (not failure) when optional services are down

### MISSION-D3: CD Pipeline
**Scope:** `.github/workflows/`
**Tasks:**
1. Create `deploy-staging.yml` — triggers on merge to `main`, builds Docker image, pushes to ECR, deploys to ECS staging
2. Create `deploy-production.yml` — manual trigger with approval gate
3. Add database migration step (run before deploy, rollback on failure)
4. Add smoke test after deploy (hit health endpoint)
5. Add Slack/Discord notification on deploy success/failure

### MISSION-D4: Database Performance
**Scope:** Migrations + query optimization
**Tasks:**
1. Add missing indexes: `annotations.page_id`, `annotations.assignee_id`
2. Move heatmap computation to a database aggregate query (eliminate JS-side processing)
3. Add `statement_timeout` to Knex connection config (30s default)
4. Add `acquireConnectionTimeout` to pool config
5. Create materialized view for reporting overview (refresh on schedule)
6. Add `EXPLAIN ANALYZE` logging for queries exceeding 100ms (in dev)

---

## Phase E: Code Quality & Architecture

### MISSION-E1: Hexagonal Architecture Consistency
**Scope:** Premium routes that bypass the domain layer
**Problem:** 10+ route files (`billing`, `workflow`, `premium`, `clientPortal`, `reporting`, `heatmap`, `feedback`, `integrations`, `oauth`, `csat`) use Knex directly in route handlers, bypassing the hexagonal architecture.
**Tasks:**
1. For each non-hex route, decide: extract to domain use case OR document as "thin CRUD"
2. Priority extractions: billing (sensitive), integrations (complex), workflow (stateful)
3. Create domain entities and ports for extracted features
4. Add use-case unit tests with fake adapters
5. Add eslint rule enforcement to prevent new direct-db-access in inbound adapters

### MISSION-E2: Component Decomposition
**Scope:** Large files
**Problem:** `Popover.ts` (110 KB), `ProjectView.ts` (49 KB), `container.ts` (36 KB)
**Tasks:**
1. Split `Popover.ts` into sub-components: `PopoverForm`, `PopoverSeverityPicker`, `PopoverScreenshotToggle`, `PopoverGuidelineSelector`
2. Split `ProjectView.ts` into: `AnnotationListView`, `KanbanBoardView`, `AnnotationDetailPanel`
3. Split `container.ts` into per-domain-module factory functions: `buildAuthContainer()`, `buildProjectContainer()`, etc.
4. Ensure all extracted components maintain existing test coverage

### MISSION-E3: Test Coverage for Premium Features
**Scope:** Untested dashboard pages and server routes
**Tasks:**
1. Write tests for `IntegrationsPage.ts`
2. Write tests for `ClientPortalPage.ts`
3. Write tests for `WorkflowsPage.ts`
4. Write tests for `ReportingPage.ts`
5. Write tests for `OnboardingWizard.ts`
6. Write tests for `HeatmapOverlay.ts`, `ReplayPlayer.ts`, `NotificationBell.ts`
7. Write tests for `ScreenshotViewer.ts` (extension)
8. Write server route tests for all premium routes
9. Target: 0 untested page/component files

### MISSION-E4: Rename Legacy Branding
**Scope:** Extension Custom Element tag prefixes
**Problem:** All Web Components use `fl-` prefix (from "FeedbackLoop" legacy name) but the product is "Pinpoint".
**Tasks:**
1. Rename all Custom Element registrations from `fl-*` to `pp-*`
2. Update all `querySelector('fl-*')` references
3. Update CSS selectors
4. Update tests
5. Consider backwards-compat alias registration for existing installs

---

## Phase F: Documentation & DX

### MISSION-F1: CONTRIBUTING.md
**Tasks:**
1. Document commit message format (Conventional Commits)
2. Document branching strategy
3. Document PR review process
4. Document code style conventions (no React, signals pattern, Web Components pattern)
5. Document testing expectations (what needs tests, property test thresholds)
6. Document the hexagonal architecture boundary rules

### MISSION-F2: Architecture Decision Records
**Scope:** New `docs/adr/` directory
**Tasks:**
1. ADR-001: No React — vanilla TS + signals + templates
2. ADR-002: Hexagonal architecture for server
3. ADR-003: Web Components in Shadow DOM for extension
4. ADR-004: Cookie + CSRF for dashboard, Bearer for extension
5. ADR-005: PostgreSQL-only (no Redis in dev)
6. ADR-006: Offline-first extension with outbox pattern
7. ADR-007: Signal-based reactivity over virtual DOM

### MISSION-F3: Swagger UI & Developer Portal
**Tasks:**
1. Serve Swagger UI at `/api/v1/docs` (use `swagger-ui-express`)
2. Register ALL endpoints with proper request/response schemas
3. Add authentication schemes documentation
4. Add webhook event catalog
5. Add rate limit documentation
6. Create a public-facing API reference page

---

## Execution Priority

```
Week 1: BUG-001 → BUG-004 (critical bugs)
Week 2: MISSION-A1, MISSION-A3 (API consistency)
Week 3: MISSION-B1, MISSION-B7 (responsive + accessibility)
Week 4: MISSION-B2, MISSION-B6 (loading states + feedback)
Week 5: MISSION-B3, MISSION-B4 (search + bulk actions)
Week 6: MISSION-A2, MISSION-A4 (pagination + audit)
Week 7: MISSION-B5 (dark mode)
Week 8: MISSION-C1 (feedback widget)
Week 9: MISSION-C2, MISSION-C3 (tags + search)
Week 10: MISSION-C4, MISSION-C5 (activity + guest mode)
Week 11: MISSION-D1, MISSION-D2, MISSION-D4 (infrastructure)
Week 12: MISSION-E1, MISSION-E2, MISSION-E3 (architecture + tests)
```

---

## How to Execute with Moonbase

Each MISSION can be run as:

```bash
cd ~/Workspace/Personal/Pinpoint
moonbase mission "Execute MISSION-A1: Standardize error response shape. See docs/ENHANCEMENTS.md for full specification."
```

Or deploy individual agents for targeted work:

```bash
moonbase deploy 1 "Analyze MISSION-B1 responsive layout requirements"
moonbase deploy 2 "Design the responsive breakpoint system for MISSION-B1"
moonbase deploy 3 "Implement MISSION-B1 responsive dashboard layout"
moonbase deploy 4 "QA MISSION-B1 — verify all breakpoints render correctly"
```
