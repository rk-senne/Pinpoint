# Implementation Plan: Pinpoint App

## Overview

This plan extends the existing Pinpoint monorepo (shared library, API server, web dashboard, Chrome Extension) with the 31 requirements in the updated spec. Tasks 1–18 from the prior plan landed the baseline (auth, projects, annotations, comments, teams, analytics, exports, real-time wiring, password-protected shared links, and the React-based clients) and are preserved as completed work. The new tasks (a) add the missing features called out in requirements 17–31, (b) close the design gaps (pages, atomic pin numbering, durable notifications, co-viewer presence, DOM resilience, structured logging, CSRF, email verification, API versioning, shared theme), and (c) migrate both clients off React onto Web Components (Extension) and vanilla TypeScript with `<template>` + signals (Dashboard).

Tasks are ordered so that foundation refactors (theme, UA parser, API versioning, logging, secret guard) land first, then the database changes that everything else depends on, then auth hardening, then the new domain features, then the durable queue, then presence and DOM resilience, then the React-removal migration, then UA wiring in the clients, and finally containerization and CI.

## Tasks

### Phase 0: Preserved Baseline (Completed Work)

- [x] 0. Existing implementation from the prior plan (tasks 1–18)
  - Monorepo, shared types/schemas/serialization (Properties 6, 7, 8)
  - API server with PostgreSQL, JWT auth, profile endpoints
  - Project CRUD, project search (Property 1), shared link verify (basic lockout), annotation CRUD with sequential pinNumber (in-process), comments (Property 5), analytics (Property 10), team CRUD with RBAC (Property 3), notification dispatch with preferences (Property 4), Socket.IO `/collab` namespace, PDF/CSV export, guidelines
  - Dashboard skeleton (React + Vite + Router): auth, project list sidebar, project view, settings, team management, shared project view, export UI
  - Extension skeleton (React + Manifest V3): OverlayManager, FloatingToolbar, DOMTargetResolver (Property 9), PopoverController, PinRenderer, SidebarPanel, MentionAutocomplete (Property 2), CollaborationClient, comment thread
  - _Baseline coverage of Requirements: 3 (annotation creation via popover and pins, refined further by Phase 10 UI migration), 4 (severity selector and color-coded pins, refined by Phase 1 shared theme), 5 (overlay toggle, floating toolbar, sidebar panel, refined by Phase 10 UI migration)_

### Phase 1: Foundation Refactors

- [x] 1. Shared theme and UA parser
  - [x] 1.1 Create `shared/src/theme.ts`
    - Export `SEVERITY_COLORS` and `STATUS_LABELS` typed `as const`
    - Export `themeCss(): string` emitting `--fl-severity-*` and `--fl-status-*` CSS Custom Properties
    - Export `sharedStyleSheet`: a constructable `CSSStyleSheet` built via `new CSSStyleSheet()` and `replaceSync(themeCss())`, ready for `adoptedStyleSheets`
    - Re-export from `shared/src/index.ts`
    - _Requirements: 26.1_

  - [x] 1.2 Add `bowser` dependency and `parseUserAgent`
    - Add `bowser` to `shared/package.json` dependencies (pinned)
    - Create `shared/src/userAgent.ts` exporting `parseUserAgent(uaString: string): EnvironmentMetadata` and `detectBraveAndArcOverrides(meta): Promise<EnvironmentMetadata>` per the design
    - `parseUserAgent` MUST never throw; on parse failure return `{ browserFamily: 'unknown', browserVersion: null, osFamily: 'unknown', osVersion: null, deviceType: 'desktop', userAgentRaw: uaString }`
    - _Requirements: 17.1, 17.2_

  - [x] 1.3 Property test for `parseUserAgent` totality
    - **Property 11: parseUserAgent is total**
    - Generate `fc.string()` (including empty, garbage, real UAs from a fixture list); assert no throw, returns object satisfying `EnvironmentMetadataSchema`
    - **Validates: Requirements 17.1, 17.2**

  - [x] 1.4 Update annotation/environment types and schemas
    - Rename `BrowserMeta` → `EnvironmentMetadata` in `shared/src/types.ts` and `shared/src/schemas.ts`
    - Make `environment` REQUIRED on `Annotation` (Zod `.required` on the new field)
    - Add `Page`, `Notification`, `AuthToken`, `BrowserFamily`, `OsFamily`, `DeviceType`, `AuthTokenKind`, `NotificationStatus` types and Zod schemas
    - Replace `pageUrl` on `Annotation` with `pageId` (keep optional `pageUrl` derived field for client convenience)
    - Update the existing annotation round-trip property (Property 6) generator to produce the new shape
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 17.3, 23.1, 23.2_

  - [x] 1.5 Add `signal` reactive primitive
    - Create `shared/src/signal.ts` exporting `signal<T>(initial)` returning `{ get, set, subscribe }`
    - `set` MUST short-circuit on `Object.is(prev, next)` to avoid redundant fires
    - Unit tests cover get, set, subscribe (initial fire), unsubscribe, and `Object.is` short-circuit
    - _Requirements: 31.1, 31.2_

- [x] 2. API versioning and error envelope
  - [x] 2.1 Mount routers under `/api/v1`
    - Update `server/src/index.ts` to mount every existing router (`auth`, `projects`, `annotations`, `comments`, `teams`, `users`, `guidelines`, `shared`) under `/api/v1` instead of `/api`
    - _Requirements: 25.1_

  - [x] 2.2 Add legacy catch-all that returns 410
    - Add an Express middleware on `/api/*` AFTER the v1 routers
    - Respond with HTTP 410 and JSON envelope `{ error: { code: 'API_VERSION_REMOVED', message: 'This endpoint moved to /api/v1.', newPath: '/api/v1' + req.path } }`
    - _Requirements: 25.2_

  - [x] 2.3 Update client API base
    - In `dashboard/src/lib/api.ts` and `extension/src/lib/api.ts` (create the latter if not yet split out from `content.ts`), define a single `API_BASE = '/api/v1'` constant and use it for every fetch call
    - _Requirements: 25.3, 25.4_

- [x] 3. Structured logging
  - [x] 3.1 Wire `pino` and `pino-http`
    - Add `pino` and `pino-http` to `server/package.json`
    - Replace every `console.error/log/warn` in `server/src/index.ts` with the root logger
    - Mount `pino-http` middleware that attaches a child logger to `req.log` and assigns `req.id = X-Request-Id || uuidv4()`
    - _Requirements: 27.1, 27.2, 27.4_

  - [x] 3.2 Update global error handler to log via `req.log`
    - Modify the existing global Express error handler to call `req.log.error({ err, code, message })` before sending the JSON envelope; include stack in dev only
    - _Requirements: 27.3_

- [x] 4. Production secret guard
  - [x] 4.1 Add `validateConfig`
    - Create `server/src/config.ts` exporting `validateConfig()` that throws when `NODE_ENV === 'production'` and `JWT_SECRET` is unset, empty, `dev-secret`, `dev-secret-change-in-production`, or `change-me`
    - Call `validateConfig()` in `server/src/index.ts` before `httpServer.listen`; on throw, log via root logger and `process.exit(1)`
    - _Requirements: 21.1, 21.2_

  - [x] 4.2 Unit test `validateConfig`
    - Cover the matrix of bad values × `NODE_ENV` (production must throw; non-production must pass; valid secret in production must pass)
    - _Requirements: 21.1, 21.2_

### Phase 1.5: API Server Hexagonal Architecture Refactor (Req 54)

This phase carves out the Domain / Adapters / Composition layers BEFORE the rest of the new feature work lands so that subsequent phases (database changes, durable queue, hexagon-shaped use cases for offline idempotency, etc.) ship into the new structure rather than retrofit.

- [x] 4.5 Set up directory layout and lint enforcement
  - [x] 4.5.1 Create `server/src/domain/`, `server/src/adapters/inbound/{http,websocket,workers}/`, `server/src/adapters/outbound/{postgres,s3,smtp,socket,bcrypt,jwt,clock,logger}/`, and `server/src/composition/`. _Requirements: 54.1_
  - [x] 4.5.2 Add `eslint-plugin-import` and configure `no-restricted-paths` (or add `dependency-cruiser` with an equivalent rule) so files under `server/src/domain/**` cannot import from `server/src/adapters/**` or from `express`, `socket.io`, `knex`, `pg`, `bcrypt`, `nodemailer`, `aws-sdk`, `@aws-sdk/*`, `pino`, `pino-http`. _Requirements: 54.2, 54.8_
  - [x] 4.5.3 Wire the lint rule into the CI workflow added in Phase 12 (task 21.1) so a violation fails the build. _Requirements: 54.8_

- [x] 4.6 Define domain entities, value objects, and Outbound_Ports
  - [x] 4.6.1 Move existing entity-shaped types from `shared/src/types.ts` to `server/src/domain/<aggregate>/<Entity>.ts` for: `Annotation`, `DOMTarget`, `EnvironmentMetadata`, `Project`, `Page`, `Comment`, `Team`, `TeamMember`, `User`, `AuthToken`, `Notification`, `Guideline`, `SharedLink`. The shared package keeps the wire-shape types and Zod schemas; the server domain layer keeps richer entities with invariants. _Requirements: 54.1_
  - [x] 4.6.2 Define Outbound_Port interfaces in `domain/<aggregate>/ports/`: `AnnotationRepo`, `ProjectRepo`, `PageRepo`, `CommentRepo`, `TeamRepo`, `TeamMemberRepo`, `UserRepo`, `AuthTokenRepo`, `SharedLinkRepo`, `GuidelineRepo`, `AnalyticsRepo`, `NotificationQueue`, `ProjectPinSequence`, `Mailer`, `ScreenshotStore`, `EventBus`, `PasswordHasher`, `TokenIssuer`, `Clock`, `Logger`. _Requirements: 54.2, 54.3_
  - [x] 4.6.3 Define typed `DomainError` class hierarchy in `domain/shared/DomainError.ts` (`NotFound`, `Forbidden`, `Conflict`, `Validation`, `Unauthorized`, `Locked`, `Unavailable`). Inbound adapters translate these to HTTP/WS codes. _Requirements: 54.4_

- [x] 4.7 Implement Use_Cases by extracting logic from current routes
  - [x] 4.7.1 Auth use cases: `registerUser`, `login`, `refreshToken`, `verifyEmail`, `requestPasswordReset`, `completePasswordReset`, `logout`. Each takes injected ports and returns a `Result<Output, DomainError>`. _Requirements: 54.3, 54.7_
  - [x] 4.7.2 Project use cases: `createProject`, `searchProjects`, `getProject`, `archiveProject`, `deleteProject`, `resolveProjectByUrl`, `listProjectMembers`, `deletePage`. _Requirements: 54.3, 54.7_
  - [x] 4.7.3 Annotation use cases: `createAnnotation` (uses `ProjectPinSequence` for atomic pin numbering), `updateAnnotation`, `changeAnnotationStatus`, `deleteAnnotation`, `attachScreenshot`. _Requirements: 54.3, 54.7_
  - [x] 4.7.4 Comment use cases: `createComment`, `listComments`. _Requirements: 54.3, 54.7_
  - [x] 4.7.5 Team use cases: `createTeam`, `listTeams`, `inviteMember`, `updateMemberRole`, `removeMember`. _Requirements: 54.3, 54.7_
  - [x] 4.7.6 Notification use cases: `enqueueNotification`, `dispatchPendingNotifications`. _Requirements: 54.3, 54.7_
  - [x] 4.7.7 Shared-link use cases: `createSharedLink`, `verifyLinkPassword` (refactor of Phase 9 Task 16.1 — implement the FSM here). _Requirements: 54.3, 54.7_
  - [x] 4.7.8 Guideline use cases: `listGuidelines`, `createCustomGuideline`. _Requirements: 54.3, 54.7_
  - [x] 4.7.9 Analytics use case: `computeAnalytics` returning bySeverity/byType/byStatus/byBrowser. _Requirements: 54.3, 54.7_
  - [x] 4.7.10 Export use case: `exportProjectReport` taking `format: 'pdf'|'csv'`. _Requirements: 54.3, 54.7_

- [x] 4.8 Implement Outbound_Adapters
  - [x] 4.8.1 `adapters/outbound/postgres/` — one repo class per Outbound_Port, the only place that imports `knex` or `pg`. _Requirements: 54.5_
  - [x] 4.8.2 `adapters/outbound/s3/S3ScreenshotStore.ts` — only place that imports `@aws-sdk/client-s3`. _Requirements: 54.5_
  - [x] 4.8.3 `adapters/outbound/smtp/NodemailerMailer.ts` — only place that imports `nodemailer`. _Requirements: 54.5_
  - [x] 4.8.4 `adapters/outbound/socket/SocketIoEventBus.ts` — implements `EventBus` by emitting Socket.IO events; only place importing `socket.io`. _Requirements: 54.5_
  - [x] 4.8.5 `adapters/outbound/bcrypt/BcryptPasswordHasher.ts` — only place importing `bcrypt`. _Requirements: 54.5_
  - [x] 4.8.6 `adapters/outbound/jwt/JwtTokenIssuer.ts` — only place importing `jsonwebtoken`; supports the 7-day refresh grace window. _Requirements: 54.5_
  - [x] 4.8.7 `adapters/outbound/clock/SystemClock.ts` — wraps `Date.now()`. _Requirements: 54.5_
  - [x] 4.8.8 `adapters/outbound/logger/PinoLogger.ts` — only place importing `pino`/`pino-http`. _Requirements: 54.5_

- [x] 4.9 Implement Inbound_Adapters (thin)
  - [x] 4.9.1 Refactor `server/src/routes/*` into `adapters/inbound/http/*.routes.ts` modules: each handler validates input via Zod, calls one Use_Case, maps `DomainError` to HTTP status. No business logic remains in handlers. _Requirements: 54.4_
  - [x] 4.9.2 Refactor existing Socket.IO setup (`server/src/websocket.ts`) into `adapters/inbound/websocket/collab.gateway.ts`. _Requirements: 54.4_
  - [x] 4.9.3 Implement `adapters/inbound/workers/notificationWorker.ts` that on a 5 s interval invokes `dispatchPendingNotifications` use case. _Requirements: 54.4_

- [x] 4.10 Composition root and integration
  - [x] 4.10.1 Implement `server/src/composition/container.ts` that constructs all concrete adapters and injects them into use-case constructors. This is the only file allowed to import both Domain and Adapters. _Requirements: 54.6_
  - [x] 4.10.2 Update `server/src/index.ts` to call `buildContainer(config)`, mount the inbound HTTP router, install the WebSocket gateway, and start the notification worker. _Requirements: 54.6_

- [x] 4.11 In-memory test doubles and use-case unit tests
  - [x] 4.11.1 Create `server/src/__tests__/fakes/` with `FakeAnnotationRepo`, `FakeProjectRepo`, `FakeUserRepo`, `FakeAuthTokenRepo`, `FakeNotificationQueue`, `FakeMailer`, `FakeScreenshotStore`, `FakeEventBus`, `FakePasswordHasher`, `FakeTokenIssuer`, `FakeClock`, `FakeLogger`. Each implements its port with deterministic behavior suitable for unit tests. _Requirements: 54.7_
  - [x] 4.11.2 Add at least one unit test per Use_Case in `server/src/domain/<aggregate>/__tests__/<usecase>.test.ts` exercising it through fakes. _Requirements: 54.7_
  - [x] 4.11.3 Move existing property tests (Properties 1, 3, 4, 5, 10, 13) to live against domain Use_Cases with fake adapters where applicable, so they no longer depend on Express or Postgres. Properties 12 (pin numbering under contention) and the integration tests for the durable queue stay against real Postgres. _Validates: Requirements 2.3, 9.4, 9.6, 10.4, 12.1, 15.3, 15.4, 15.5, 15.6, 16.1_

### Phase 2: Database — Pages, Pin Counter, Auth Tokens, Notifications

- [x] 5. Migrations
  - [x] 5.1 Migration: introduce `pages` table
    - Up: create `pages (id, project_id, url, title, created_at)` with UNIQUE `(project_id, url)`; backfill from `annotations.page_url`; add `annotations.page_id` NOT NULL referencing `pages.id`; drop `annotations.page_url`
    - Down: re-add `annotations.page_url`, copy from `pages.url` via `page_id`, drop `page_id`, drop `pages`
    - _Requirements: 23.1, 23.2, 23.3_

  - [x] 5.2 Migration: per-project `pin_counter`
    - Up: `ALTER TABLE projects ADD COLUMN pin_counter integer NOT NULL DEFAULT 0`; backfill `pin_counter = MAX(annotations.pin_number)` per project
    - Down: drop the column
    - _Requirements: 24.1, 24.3_

  - [x] 5.3 Migration: rename `password_resets` → `auth_tokens`
    - Up: rename table; add `kind text NOT NULL DEFAULT 'reset_password'` column
    - Down: drop `kind`; rename back to `password_resets`
    - _Requirements: 1.1, 20.1_

  - [x] 5.4 Migration: create `notifications` table
    - Up: create `notifications (id, status, attempts, payload jsonb, scheduled_at, last_error, created_at, updated_at)` with `CHECK (status IN ('pending','sent','failed'))`; add index on `(status, scheduled_at)`
    - Down: drop the table
    - _Requirements: 28.1_

  - [x] 5.5 Migration: add `users.verified`
    - Up: `ALTER TABLE users ADD COLUMN verified boolean NOT NULL DEFAULT true` (existing rows stay verified)
    - App code MUST default `verified=false` for new rows after this lands
    - Down: drop the column
    - _Requirements: 20.1_

  - [x] 5.6 Migration: JSONB index for analytics
    - Up: `CREATE INDEX annotations_environment_browser_idx ON annotations ((environment->>'browserFamily'))`
    - Down: drop the index
    - _Requirements: 16.1, 17.5_

### Phase 3: Auth Hardening

- [x] 6. Email verification
  - [x] 6.1 Update register flow
    - `POST /api/v1/auth/register` now creates the user with `verified=false`, generates an `auth_tokens` row with `kind='verify_email'` (24 h TTL), and emails the verification link
    - _Requirements: 20.1_

  - [x] 6.2 Implement verify-email endpoint
    - `POST /api/v1/auth/verify-email/:token` validates token, marks `users.verified=true`, marks the auth token used; returns 200 on success, 400 on invalid/expired
    - _Requirements: 20.2, 20.3_

  - [x] 6.3 Implement resend verification
    - `POST /api/v1/auth/resend-verification` issues a fresh `verify_email` auth token (rate-limited via the strict limiter)
    - _Requirements: 20.1_

  - [x] 6.4 Block login until verified
    - `POST /api/v1/auth/login` returns 401 with `{ error: { code: 'EMAIL_NOT_VERIFIED' } }` when `users.verified=false`
    - _Requirements: 20.4_

  - [x] 6.5 Dashboard verify-email page
    - Add `/verify-email/:token` route in the dashboard router with success and error states (uses the new vanilla router from task 18.1 once available; until then, keep the React route)
    - _Requirements: 20.2, 20.3_

- [x] 7. Cookie session and CSRF
  - [x] 7.1 Issue cookies and body token on login
    - `POST /api/v1/auth/login` now sets `Set-Cookie: fl_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/` AND `Set-Cookie: fl_csrf=<rand32>; SameSite=Lax; Path=/` AND returns `{ user, csrfToken, token }` (the body `token` is for the Extension)
    - _Requirements: 18.1, 18.3_

  - [x] 7.2 CSRF middleware
    - Create `server/src/middleware/csrf.ts` enforcing `X-CSRF-Token` header equals `fl_csrf` cookie for `POST/PUT/PATCH/DELETE` under `/api/v1`
    - Skip when the request is authenticated by `Authorization: Bearer` and no `fl_session` cookie is present (Extension proof-of-possession exempt)
    - Wire in `server/src/index.ts` after auth, before route handlers
    - _Requirements: 18.4, 18.5, 18.6, 18.7_

  - [x] 7.3 Auth middleware accepts cookie OR bearer
    - Update `server/src/middleware/auth.ts` to read JWT from `fl_session` cookie OR `Authorization: Bearer <token>`; reject when neither is present
    - _Requirements: 18.6_

  - [x] 7.4 Dashboard auth lib uses cookies + CSRF
    - Remove `localStorage` token storage from `dashboard/src/lib/auth.ts`
    - Capture `csrfToken` from the login response body into a module-level variable
    - In `dashboard/src/lib/api.ts`, attach `X-CSRF-Token` header on every mutating request and `credentials: 'include'` on every fetch
    - _Requirements: 18.2, 18.4_

  - [x] 7.5 Logout endpoint
    - `POST /api/v1/auth/logout` clears `fl_session` and `fl_csrf` cookies (`Max-Age=0`)
    - _Requirements: 18.1_

- [x] 8. Password and rate limiting
  - [x] 8.1 Password floor and blocklist
    - Bundle a top-10k common passwords list as `shared/data/common-passwords.json`
    - Validate at register and password change: minimum length 10, reject if present in the blocklist (case-insensitive); return 400 with descriptive error
    - _Requirements: 1.10, 1.11_

  - [x] 8.2 Strict auth rate limiter
    - Add an `express-rate-limit` instance keyed on `req.ip + (body.email || '')` with 10 req / 15 min
    - Wire to `/auth/login`, `/auth/register`, `/auth/reset-password`, `/auth/resend-verification`, `/shared/:linkId/verify` (under `/api/v1`)
    - _Requirements: 19.1, 19.2, 19.3_

### Phase 4: Page Entity and Pin Numbering

- [x] 9. Pages API
  - [x] 9.1 Project create accepts multiple URLs
    - `POST /api/v1/projects` body: `{ name, urls: string[] }`. In a single transaction, create the project and one `pages` row per URL
    - _Requirements: 2.1, 23.1_

  - [x] 9.2 Lookup by URL
    - `GET /api/v1/projects/by-url?url=<encoded>` returns `{ projectId, pageId }` or 404
    - _Requirements: 22.1, 22.2_

  - [x] 9.3 Delete page
    - `DELETE /api/v1/projects/:id/pages/:pageId?onNonEmpty=cascade|block` (default `block`)
    - `block` returns 409 with `{ error: { code: 'PAGE_NOT_EMPTY', details: { count } } }` when annotations exist on the page
    - `cascade` deletes annotations then the page in one transaction
    - _Requirements: 23.4, 23.5_

  - [x] 9.4 Annotation create/list use `page_id`
    - `POST /api/v1/projects/:id/annotations` resolves the request URL → `page_id` by lookup; auto-creates a page within the project if absent
    - `GET` responses include both `pageId` and a derived `pageUrl` for convenience
    - _Requirements: 23.2_

- [x] 10. Atomic pin numbering
  - [x] 10.1 Wrap insert in a counter transaction
    - Wrap the annotation insert in `BEGIN; UPDATE projects SET pin_counter = pin_counter + 1 WHERE id = $1 RETURNING pin_counter; INSERT INTO annotations (..., pin_number=$pin_counter); COMMIT;`
    - Remove the old in-process counter
    - _Requirements: 24.1, 24.3_

  - [x] 10.2 Property test: parallel insert pin uniqueness
    - **Property 12: pin numbers are unique under contention**
    - Spin 32 parallel `POST /annotations` against a fresh project against a real Postgres test DB; assert all returned pin numbers are distinct and contiguous-or-gap-permitted
    - **Validates: Requirements 24.1, 24.2**

### Phase 5: Project Members and Analytics

- [x] 11. Members and assignee dropdown
  - [x] 11.1 Members endpoint
    - `GET /api/v1/projects/:id/members` returns `[{ userId, name, email, avatarUrl, role }]`
    - _Requirements: 22.4_

  - [x] 11.2 Assignee dropdown
    - In the dashboard project view, replace the assignee text input on bug-report annotations with a dropdown populated from the new endpoint
    - _Requirements: 22.6, 8.4_

- [x] 12. Analytics by browser
  - [x] 12.1 Add `byBrowser` breakdown
    - Update `GET /api/v1/projects/:id/analytics` to include `byBrowser: Record<BrowserFamily, number>` aggregated from `annotations.environment->>'browserFamily'`
    - _Requirements: 16.1, 17.5_

  - [x] 12.2 Extend Property 10 to cover `byBrowser`
    - Update the existing analytics aggregation property test so the dimension sum invariant also holds for the `byBrowser` dimension
    - **Validates: Requirements 16.5**

### Phase 6: Notifications Durability

- [x] 13. Durable queue
  - [x] 13.1 Queue service skeleton
    - Create `server/src/services/notificationQueue.ts` exporting `enqueue(payload)` and a polling worker started from `index.ts`
    - Worker uses `SELECT … FOR UPDATE SKIP LOCKED LIMIT 10` inside a transaction every 5 s
    - _Requirements: 28.1, 28.2, 28.3_

  - [x] 13.2 Dispatch with backoff
    - On dispatch success, set `status='sent'`
    - On failure, increment `attempts`, set `last_error`, and either reschedule with backoff `2^attempts` minutes capped at 32 (so 2, 4, 8, 16, 32) or set `status='failed'` after 5 attempts
    - _Requirements: 28.4, 28.5, 28.6_

  - [x] 13.3 Replace direct mailer calls
    - In every route handler that currently invokes nodemailer (annotation/comment/mention/promotion/project-deletion paths), replace the call with `enqueue(payload)`
    - _Requirements: 10.3, 12.4_

  - [x] 13.4 Integration test: failing then succeeding SMTP
    - Mock the mailer to fail twice then succeed; assert the row goes `pending → pending → sent` with `attempts` incremented and `last_error` recorded on the failures
    - _Requirements: 28.5_

  - [x] 13.5 Document no-replay on boot
    - Add a comment in `notificationQueue.ts` next to the worker start, stating that no explicit boot-time replay is needed because the poller picks up `status='pending' AND scheduled_at <= now()`
    - _Requirements: 28.7_

### Phase 7: Real-time Co-Viewer Presence

- [x] 14. Presence
  - [x] 14.1 Server presence map
    - In the Socket.IO `/collab` namespace, handle `annotation:open` and `annotation:close` events; maintain `Map<annotationId, Set<userId>>`; broadcast `annotation:viewers` to the annotation's room on every change; clean up on socket disconnect
    - _Requirements: 6.6, 6.7_

  - [x] 14.2 Extension overlay store and rendering
    - Add `viewersByAnnotation: Signal<Record<string, string[]>>` to the extension overlay store
    - Emit `annotation:open` on popover open and `annotation:close` on popover close
    - Render co-viewer list (avatars or initials) in the popover header
    - _Requirements: 6.6, 6.7_

  - [x] 14.3 Dashboard popover indicator
    - The dashboard project-view annotation detail panel renders the same indicator from the same socket events
    - _Requirements: 6.6, 6.7_

  - [x] 14.4 Integration test: two-socket presence
    - Open two sockets, both emit `annotation:open` for the same id; both must receive `annotation:viewers` containing both user ids; one disconnects; the other receives an updated list with the disconnected user removed
    - _Requirements: 6.6, 6.7_

### Phase 8: DOM Resilience

- [x] 15. PinPositioner
  - [x] 15.1 Implement `PinPositioner`
    - Create `extension/src/lib/PinPositioner.ts` per the design: `MutationObserver` on `document.body` (subtree, childList, attributes filtered to `class/style/hidden`), `ResizeObserver` on `document.documentElement`, `scroll` listener on document (capture, passive) and `resize` on window (passive), all coalesced through a single `requestAnimationFrame` tick
    - _Requirements: 14.5, 14.6_

  - [x] 15.2 Wire PinPositioner into the overlay
    - Instantiate one `PinPositioner` from the overlay root; on each annotation render, call `register(id, pinEl, target)`; on unmount, `unregister(id)`
    - Remove direct `top`/`left` styling; pin elements are positioned exclusively via `transform: translate3d(x, y, 0)`
    - _Requirements: 14.2, 14.5_

  - [x] 15.3 Fallback rendering
    - When the resolved element is `null`, set `data-fallback="true"` on the pin and apply the warning ring style from `theme.ts`
    - _Requirements: 14.3, 14.6_

### Phase 9: Shared Link State Machine

- [x] 16. `verifyLinkPassword` service
  - [x] 16.1 Extract single service function
    - Create `server/src/services/sharedLinks.ts` exporting `verifyLinkPassword(linkId, password)` implementing the FSM in the design (load link, expire stale lock, compare, increment failed_attempts, lock after 3, return 200/401/423 with `Retry-After`)
    - Refactor `server/src/routes/shared.ts` to delegate exclusively to this function; remove all duplicate state mutation logic
    - _Requirements: 15.3, 15.4, 15.5, 15.6_

  - [x] 16.2 Property test for the lockout FSM
    - **Property 13: shared link lockout state machine**
    - Generate random sequences of `(correct|incorrect, advanceClockMinutes)` events; assert at every step the state matches the FSM (locked iff `failed_attempts >= 3 AND locked_until > now`; correct password while not locked clears counters; success after lock expiry resets counters before evaluating)
    - **Validates: Requirements 15.3, 15.4, 15.5, 15.6**

### Phase 10: UI Migration off React

- [x] 17. Extension Web Components migration
  - [x] 17.1 Build the shared stylesheet for Shadow Roots
    - Create `extension/src/styles/sharedStyleSheet.ts` that combines `themeCss()` from `@pinpoint/shared/theme` with the existing overlay CSS (currently inline in `content.ts` and `SidebarPanel.tsx`) into a single `CSSStyleSheet` and exports it for `adoptedStyleSheets`
    - _Requirements: 26.1, 31.2_

  - [x] 17.2 Convert `FloatingToolbar` to `<fl-floating-toolbar>`
    - HTMLElement subclass, open Shadow Root, `adoptedStyleSheets = [sharedStyleSheet]`, `<template>` clone in constructor; `connectedCallback` wires button click handlers; `disconnectedCallback` removes them; preserve all existing behavior (close, avatar, share, link)
    - _Requirements: 31.2, 31.3_

  - [x] 17.3 Convert `PinRenderer` to `<fl-annotation-pin>`
    - One Custom Element per pin; expose `annotation` property setter; emit `pin-click` `CustomEvent` on click; severity color from `SEVERITY_COLORS` via CSS Custom Property
    - _Requirements: 31.2, 31.3_

  - [x] 17.4 Convert `MentionAutocomplete` to `<fl-mention-autocomplete>`
    - Receive `members` and `query` via properties; emit `select` event with the chosen member; reuses the existing `mentionFilter` logic unchanged
    - _Requirements: 31.3_

  - [x] 17.5 Convert `CommentThread` to `<fl-comment-thread>`
    - Receive `comments` via property; render an `<ol>` of comment templates; emit `submit` event when a comment is posted
    - _Requirements: 31.3_

  - [x] 17.6 Convert `SidebarPanel` to `<fl-sidebar-panel>`
    - Receive `annotations` via property; render Active and Resolved tabs; emit `annotation-select` events
    - _Requirements: 31.3_

  - [x] 17.7 Convert `PopoverController` to `<fl-popover>`
    - Owns the popover lifecycle (open/close anchored to a target DOMRect); slots in `<fl-mention-autocomplete>` and `<fl-comment-thread>`; emits `submit`, `cancel`, `close`
    - _Requirements: 31.3_

  - [x] 17.8 Convert `OverlayManager` to `<fl-overlay-host>`
    - Single root element; instantiates `PinPositioner`; mounts the Socket.IO client; owns the overlay store (signals for `annotations`, `comments`, `selectedAnnotationId`, `popoverTarget`, `members`, `reconnecting`, `viewersByAnnotation`); subscribes children via property assignment in subscribe callbacks
    - _Requirements: 31.2, 31.3_

  - [x] 17.9 Update content script to mount the host
    - `extension/src/content.ts` now creates the Shadow Root and appends only `<fl-overlay-host>`; deletes all React-specific bootstrap
    - _Requirements: 31.4_

  - [x] 17.10 Drop React from extension package
    - Remove `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react` from `extension/package.json`; update `extension/vite.config.ts` to drop the React plugin
    - _Requirements: 31.2_

  - [x] 17.11 Re-run mention filter property test
    - Confirm Property 2 still passes against `<fl-mention-autocomplete>` (the underlying `mentionFilter` module is unchanged)
    - **Validates: Requirements 3.3, 12.3**

- [x] 18. Dashboard React removal
  - [x] 18.1 Tiny router
    - Create `dashboard/src/lib/router.ts` (~50 LOC) using `history.pushState` + `onpopstate`; supports route patterns with `:param` parsing; exports `navigate(path)` and `useRoute(): Signal<{ path, params }>`
    - Unit-test parameter parsing against fixtures
    - _Requirements: 31.1_

  - [x] 18.2 Render helpers
    - Create `dashboard/src/lib/render.ts` with `template(id)` (clones a `<template>` by id), `bind(el, model)` (sets `data-bind` text content + class toggles from a typed model), and a typed `delegate(root, selector, event, handler)` event-delegation helper
    - _Requirements: 31.1_

  - [x] 18.3 Stores
    - Create `dashboard/src/stores/{authStore,projectListStore,projectStore,settingsStore,teamsStore}.ts` each composed of `signal<T>()` slices; one module per surface
    - _Requirements: 31.1_

  - [x] 18.4 Convert `AuthPage`
    - Replace `dashboard/src/pages/AuthPage.tsx` with `dashboard/src/pages/AuthPage.ts` using `<template>` + `bind` + `delegate`; supports login, register, password reset; reads/writes `authStore`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 31.1_

  - [x] 18.5 Convert `AppLayout`
    - Vanilla TS sidebar-shell that renders the project sidebar slot and a content slot; consumes `useRoute()` for active link styling
    - _Requirements: 31.1_

  - [x] 18.6 Convert `ProjectListSidebar`
    - Search input wired to a substring filter; context menu (rename/archive/delete/details/copy/open); create-project dialog accepting `name` + `urls[]`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 18.7 Convert `DashboardHome`
    - Empty state and recent-project list using `projectListStore`
    - _Requirements: 31.1_

  - [x] 18.8 Convert `ProjectView`
    - Analytics panel (severity / type / status / **byBrowser**), annotation list, kanban with HTML5 drag-and-drop, detail view, member-dropdown assignee, real-time updates via the project socket
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 22.6, 8.4_

  - [x] 18.9 Convert `SettingsPage`
    - Profile, Notifications, Guidelines tabs as separate templates rendered inside one route
    - _Requirements: 1.7, 1.8, 7.2, 7.3, 7.6, 10.1, 10.2_

  - [x] 18.10 Convert team management UI
    - Team list, create team, invite by email, role change, remove member
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

  - [x] 18.11 Convert `SharedProjectView`
    - Password prompt + lockout countdown driven by the `Retry-After` header from 423 responses
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 18.12 Convert verify-email page
    - `/verify-email/:token` calling `POST /api/v1/auth/verify-email/:token` and rendering success or error
    - _Requirements: 20.2, 20.3_

  - [x] 18.13 Replace inline severity colors and status labels
    - Delete the inline `SEVERITY_COLORS` map in `dashboard/src/pages/ProjectView` and any inline status label constants; import from `@pinpoint/shared/theme`; inject `themeCss()` once at boot via a `<style>` tag in `index.html`'s `<head>`
    - _Requirements: 26.3_

  - [x] 18.14 Drop React from dashboard package
    - Remove `react`, `react-dom`, `react-router-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react` from `dashboard/package.json`
    - _Requirements: 31.1_

  - [x] 18.15 Update Vite config
    - Update `dashboard/vite.config.ts` to drop the React plugin; keep CSS Modules (Vite default)
    - _Requirements: 31.1_

### Phase 11: Browser Detection in Clients

- [x] 19. Wire UA detection on annotation create
  - [x] 19.1 Extension popover submit
    - On submit in `<fl-popover>`, call `parseUserAgent(navigator.userAgent)`, then `await detectBraveAndArcOverrides(meta)`, then attach `meta` as `environment` on the create-annotation request
    - _Requirements: 17.1, 17.2_

  - [x] 19.2 Extension popover summary
    - In the popover details panel, render a single-line summary like `"Reported on Chrome 124 on macOS 14.5"` and an expandable details section with the full `EnvironmentMetadata`
    - _Requirements: 8.2, 17.4_

  - [x] 19.3 Dashboard annotation detail
    - Same single-line summary + expandable details in the dashboard annotation detail view
    - _Requirements: 8.3, 17.4_

  - [x] 19.4 Export columns
    - Update PDF and CSV export generators to include `browserFamily`, `browserVersion`, `osFamily`, `osVersion`, `deviceType` columns
    - _Requirements: 11.3, 11.4_

  - [x] 19.5 Dashboard analytics panel
    - Add a "By Browser" panel rendering `analytics.byBrowser` alongside the existing severity/type/status panels
    - _Requirements: 16.1, 17.5_

### Phase 12: Operations

- [x] 20. Docker Compose
  - [x] 20.1 `docker-compose.yml`
    - Create at repo root with services: `db` (`postgres:16-alpine` + `pg_isready` healthcheck), `migrate` (one-shot `knex migrate:latest`, `depends_on: { db: { condition: service_healthy } }`), `api` (`depends_on: { migrate: { condition: service_completed_successfully } }`), `dashboard` (`vite preview` on the built bundle)
    - _Requirements: 29.1, 29.2, 29.3_

  - [x] 20.2 README quickstart
    - Update `README.md` with the one-command `docker compose up` flow and required env vars
    - _Requirements: 29.1_

- [x] 21. CI
  - [x] 21.1 GitHub Actions workflow
    - Create `.github/workflows/ci.yml`: triggers on `pull_request`; matrix Node 20; jobs `lint`, `typecheck`, `unit`, `property`; the `unit` and `property` jobs use a `postgres:16` service container so the integration and property suites have a real DB
    - _Requirements: 30.1, 30.2, 30.3_

### Phase 13: Final Checkpoint

- [x] 22. End-to-end and wrap
  - [x] 22.1 Update existing E2E tests
    - Cover registration → verify email → login; project creation with multiple URLs producing pages; export including the new browser columns
    - _Requirements: 1.1, 20.1, 20.2, 20.3, 23.1, 11.3, 11.4_

  - [x] 22.2 Document the migration
    - Add a "Migration Notes" section in `README.md` covering: removed React (Web Components in extension, vanilla TS in dashboard), introduced `pages` entity, browser detection on every annotation, durable notification queue, API now under `/api/v1`
    - _Requirements: 25.1, 23.1, 17.3, 28.1, 31.1_

  - [x] 22.3 Final test run
    - Run lint + typecheck + unit + property + integration + E2E; ensure all green; ask the user if questions arise
    - _Requirements: 30.1, 30.2, 30.3_

### Phase 14: Extension Build Pipeline & Installability (Req 32)

- [x] 23. Bundle the extension with `@crxjs/vite-plugin`
  - [x] 23.1 Add `@crxjs/vite-plugin` and `vite` as dev deps; create `extension/vite.config.ts` with the plugin wired to `extension/manifest.json`. _Requirements: 32.1_
  - [x] 23.2 Replace `tsc --build` build script in `extension/package.json` with `vite build`; the dev script becomes `vite`. _Requirements: 32.1_
  - [x] 23.3 Add placeholder `extension/icons/icon{16,48,128}.png`. _Requirements: 32.2_
  - [x] 23.4 Edit `extension/manifest.json`: replace `"matches": ["<all_urls>"]` with explicit `host_permissions` derived from configured allow-list; keep `activeTab`, `scripting`, `storage`, add `tabs`. _Requirements: 32.3_
  - [x] 23.5 Verify a fresh `npm run build` produces a `dist/` that loads via `chrome://extensions` "Load unpacked" without further steps. _Requirements: 32.1_

### Phase 15: Extension Auth Surface and Token Refresh (Req 33)

- [x] 24. In-extension login/logout and refresh flow
  - [x] 24.1 Add a `popup.html` + `popup.ts` login surface to the extension; submits to `/api/v1/auth/login`, stores Bearer_Token in `chrome.storage.local`. _Requirements: 33.1_
  - [x] 24.2 Add a logout control in the options page that calls `POST /api/v1/auth/logout` and clears the stored Bearer_Token. _Requirements: 33.2_
  - [x] 24.3 Implement `POST /api/v1/auth/refresh` on the server: accepts a Bearer_Token within a 7-day post-`exp` grace window; returns a freshly minted token. _Requirements: 33.3_
  - [x] 24.4 Wrap the extension's API client so every fetch checks token `exp`; if within 5 minutes of expiry, transparently call `/auth/refresh` first. _Requirements: 33.4_
  - [x] 24.5 On any 401 from the API, the client clears the token and opens the popup login. _Requirements: 33.5_
  - [x] 24.6 Integration test: token-refresh round-trip; expired-but-in-grace-window refresh; out-of-grace refresh fails. _Requirements: 33.3, 33.4_

### Phase 16: Screenshot Capture and Markup (Reqs 34, 35)

- [x] 25. Screenshot capture pipeline
  - [x] 25.1 Add `screenshot_object_key TEXT NULL` column on `annotations` via a new migration. _Requirements: 34.3_
  - [x] 25.2 Service worker: handler for `'CAPTURE_VISIBLE_TAB'` message that calls `chrome.tabs.captureVisibleTab` and returns the base64 PNG. _Requirements: 34.1_
  - [x] 25.3 In `<fl-popover>`, on submit (when capture is enabled), `postMessage` to background, await the screenshot. _Requirements: 34.1_
  - [x] 25.4 Add per-annotation toggle in the popover footer ("Attach screenshot"). Persist last choice in `chrome.storage.local`. _Requirements: 34.2_
  - [x] 25.5 Implement `POST /api/v1/annotations/:id/screenshot` accepting `multipart/form-data` with `image` and `redactionRects` fields; persists to S3 and updates `annotations.screenshot_object_key`. _Requirements: 34.3_
  - [x] 25.6 Render the screenshot inline in extension and dashboard annotation detail views. _Requirements: 34.4_
  - [x] 25.7 Update PDF and CSV exporters to include the screenshot URL or embedded image. _Requirements: 34.5_
  - [x] 25.8 Integration test: submit annotation with capture enabled → S3 object exists → annotation row has key → detail view renders image. _Requirements: 34.1, 34.3, 34.4_

- [x] 26. Screenshot markup editor
  - [x] 26.1 Implement `<fl-markup-editor>` Custom Element rendering a canvas + transparent SVG overlay. Supports rectangles, arrows, freehand, pixelate. _Requirements: 35.1_
  - [x] 26.2 Persist Markup_Document JSON as a sibling S3 object (`<key>.markup.json`). On view, composite SVG over screenshot. _Requirements: 35.2_
  - [x] 26.3 Implement undo using a stack of operations. _Requirements: 35.3_

### Phase 17: Console & Network Capture (Req 36)

- [x] 27. Capture buffers and bug-report attachment
  - [x] 27.1 Add `captured_console JSONB NULL` and `captured_network JSONB NULL` columns to `annotations`. _Requirements: 36.2_
  - [x] 27.2 Implement a `CaptureBuffer` module that wraps `console.{log,warn,error}` and runs a `PerformanceObserver({type:'resource', buffered:true})`, each ring-buffered to 50 entries. _Requirements: 36.1_
  - [x] 27.3 On bug-report submit (type=note + severity in {Critical, Major}), include the buffers in the create-Annotation request. _Requirements: 36.2_
  - [x] 27.4 Render collapsible "Console" and "Network" sections in the annotation detail view (extension + dashboard). _Requirements: 36.3_
  - [x] 27.5 Add capture toggles to the extension options page; default both ON. _Requirements: 36.4_

### Phase 18: Hover Preview & SPA Navigation (Reqs 37, 38)

- [x] 28. Element-hover preview
  - [x] 28.1 Implement a single absolutely-positioned `<div class="fl-hover-outline">` inside the Shadow DOM; on `pointermove`, throttled with rAF, set its transform/width/height from `document.elementFromPoint` rect. Uses `pointer-events: none`. _Requirements: 37.1, 37.2_
  - [x] 28.2 Hide the outline when the popover opens. _Requirements: 37.3_

- [x] 29. SPA navigation handling
  - [x] 29.1 Patch `history.pushState`/`replaceState` in the content script; dispatch a `pinpoint:locationchange` event. _Requirements: 38.1_
  - [x] 29.2 Service worker listens to `chrome.webNavigation.onHistoryStateUpdated`; messages the active tab to re-resolve. _Requirements: 38.1_
  - [x] 29.3 On either signal, the overlay re-runs `GET /api/v1/projects/by-url`, refreshes Sidebar_Panel + pins, and joins the new project room. _Requirements: 38.1_
  - [x] 29.4 If no project matches, show the project picker fallback (Phase 19). _Requirements: 38.2_

### Phase 19: Manual Project Picker Fallback (Req 39)

- [x] 30. Picker UI + remembered mappings
  - [x] 30.1 Implement `<fl-project-picker>` Custom Element rendering a recent-first dropdown of accessible projects. _Requirements: 39.1_
  - [x] 30.2 On selection, persist `{ urlKey: projectId }` to `chrome.storage.local` where `urlKey = origin + pathname`. _Requirements: 39.2_
  - [x] 30.3 On overlay enable, consult the cache before calling `by-url`. _Requirements: 39.2_

### Phase 20: Keyboard Shortcuts and Drafts (Reqs 40, 41)

- [x] 31. Shortcuts
  - [x] 31.1 Add `commands` block to `manifest.json`: toggle (`Alt+Shift+F`), sidebar (`Alt+Shift+S`), next pin (`Alt+]`), prev pin (`Alt+[`). _Requirements: 40.1_
  - [x] 31.2 Service worker dispatches each command to the active tab's content script. _Requirements: 40.1_
  - [x] 31.3 Document the remap path (`chrome://extensions/shortcuts`) in the README. _Requirements: 40.2_

- [x] 32. Draft persistence
  - [x] 32.1 On every input event in the popover, debounce 300 ms and write `{ url: draft }` to `chrome.storage.session`. _Requirements: 41.1_
  - [x] 32.2 On popover open, look up by URL and prefill. _Requirements: 41.2_
  - [x] 32.3 On submit success, delete the draft. _Requirements: 41.3_

### Phase 21: Accessibility & Dark Mode (Reqs 42, 43)

- [x] 33. Accessibility
  - [x] 33.1 In `<fl-popover>`, host a `<dialog>` element internally to leverage native focus-trap and Escape semantics. _Requirements: 42.1, 42.2, 42.3_
  - [x] 33.2 Apply ARIA roles per the design: `role="toolbar"` on `<fl-floating-toolbar>`, `role="listbox"` + arrow-key nav on `<fl-mention-autocomplete>` and `<fl-sidebar-panel>`. _Requirements: 42.1_
  - [x] 33.3 Restore focus to the previously-focused element on popover close. _Requirements: 42.3_

- [x] 34. Dark mode
  - [x] 34.1 Extend `themeCss()` with a `@media (prefers-color-scheme: dark)` block that overrides only neutral CSS variables. _Requirements: 43.1, 43.2_
  - [x] 34.2 Verify `Severity_Colors` are unchanged across modes. _Requirements: 43.2_

### Phase 22: Offline Mode (Req 44)

- [x] 35. Server idempotency
  - [x] 35.1 Add migration: `client_request_id UUID UNIQUE NULL` columns on `annotations` and `comments`. _Requirements: 44.3_
  - [x] 35.2 Update `POST /api/v1/projects/:id/annotations` and `POST /api/v1/annotations/:id/comments` to accept a `clientRequestId`; if a row already exists with that id, return it (200) with header `X-FL-Idempotent-Replay: true` instead of inserting a duplicate. _Requirements: 44.3_

- [x] 36. Outbox + Syncer
  - [x] 36.1 Implement an `Outbox` in `chrome.storage.local`: ordered list of `OutboxEntry` rows with `localUuid`, `kind`, `payload`, `pendingSync=true`. _Requirements: 44.2_
  - [x] 36.2 Update the extension's API client: every mutating call writes to the outbox first, returns the local UUID, optimistically inserts the local row, and triggers the syncer. _Requirements: 44.1, 44.2_
  - [x] 36.3 Implement a `Syncer` that runs on `online` events and a 30 s interval; replays outbox entries in order, attaching `clientRequestId = localUuid`. _Requirements: 44.3_
  - [x] 36.4 On success, replace the local UUID and any references with the server-assigned id and `pinNumber`. _Requirements: 44.3_
  - [x] 36.5 On 403/404/409, move the entry to a `Sync_Conflict_Tray` with the conflict reason; render the tray in the sidebar with Retry / Edit / Discard actions. _Requirements: 44.4_
  - [x] 36.6 While offline, disable actions that require server state (e.g., resolve an unsynced annotation). _Requirements: 44.5_
  - [x] 36.7 On replay of a queued create-Annotation, re-resolve the DOM target's selector and flag the local pin with the warning indicator if it no longer matches. _Requirements: 44.6_
  - [x] 36.8 Show an "Offline" banner in the floating toolbar based on `navigator.onLine` plus an actively-failing-API heartbeat. _Requirements: 44.1_
  - [x] 36.9 Property test: outbox replay preserves order. **Property 14**. _Validates: Requirements 44.3_
  - [x] 36.10 Property test: idempotent annotation creation. **Property 15**. _Validates: Requirements 44.3_

### Phase 23: PII Redaction, Allow/Block List, Disclosure (Reqs 45, 46, 47)

- [x] 37. PII redaction
  - [x] 37.1 Client-side: compute a list of `BoundingBox` rects for elements matching the redaction predicate (`<input type=password>`, `autocomplete=cc-*`, `data-fl-redact`, configured aria-label regex). Send with the screenshot upload. _Requirements: 45.1_
  - [x] 37.2 Server-side: apply Gaussian blur over the supplied rects before persisting the screenshot. _Requirements: 45.1_
  - [x] 37.3 Honor `data-fl-no-redact` to opt elements out. _Requirements: 45.2_
  - [x] 37.4 In the markup editor, the user can paint additional regions to blur; these are appended to the redaction rects. _Requirements: 45.3_

- [x] 38. Allow/block list
  - [x] 38.1 Add an options page (`extension/options/`) with two textareas (allow + block); persisted to `chrome.storage.sync`. _Requirements: 46.1_
  - [x] 38.2 Content script bails on injection when the host matches the block-list. _Requirements: 46.2_
  - [x] 38.3 When the allow-list is non-empty and the host doesn't match, the content script does not inject. _Requirements: 46.3_
  - [x] 38.4 Pattern matching supports exact hosts and `*.example.com` wildcards. _Requirements: 46.4_

- [x] 39. Disclosure modal
  - [x] 39.1 On first popover open per host or after a settings change, render a one-time disclosure modal listing every data category that will be sent. _Requirements: 47.1_
  - [x] 39.2 Persist the "seen" flag in `chrome.storage.sync` keyed by host; reset on capture-toggle changes. _Requirements: 47.1_
  - [x] 39.3 Include a privacy-policy URL link and a button to open the options page. _Requirements: 47.2_

### Phase 24: Cross-Frame, CSP-Strict, Error Boundaries, Perf Budget (Reqs 48, 49, 50, 51)

- [x] 40. Cross-frame relay
  - [x] 40.1 Set `"all_frames": true` on the content script entry. _Requirements: 48.1_
  - [x] 40.2 In sub-frames, register only a tiny click-relay that `postMessage`s the click rect to the top frame. _Requirements: 48.2_
  - [x] 40.3 Top-frame `<fl-overlay-host>` listens for relay messages and opens the popover anchored at the relayed coordinates. _Requirements: 48.2_
  - [x] 40.4 Skip cross-origin frames. _Requirements: 48.3_

- [x] 41. CSP-strict resilience
  - [x] 41.1 Audit the codebase: no inline event handlers, no inline `<style>` strings on host elements, no `eval`/`new Function`/`setTimeout(string)`. _Requirements: 49.1_
  - [x] 41.2 Confirm constructable stylesheets are the primary path; static `<style>` inside Shadow Root is the documented fallback. _Requirements: 49.2_
  - [x] 41.3 Integration test: a CSP `default-src 'none'; script-src 'self'` page renders the overlay correctly. _Requirements: 49.1, 49.2_

- [x] 42. Error boundaries
  - [x] 42.1 Implement a `withBoundary(target, methodName)` decorator that wraps Custom Element lifecycle and event handlers in try/catch; on error, render `<fl-error-tag>` inside the affected element and continue. _Requirements: 50.1_
  - [x] 42.2 Wrap content script mount/unmount in a `ContentScriptBoundary` that never propagates exceptions to the host. _Requirements: 50.2_

- [x] 43. PinPositioner perf budget
  - [x] 43.1 Add a sliding-window mutation counter; when > 60/s sustained over 5 s, switch from rAF to a 250 ms throttle and emit a `pino` warning via the structured-logger pattern. _Requirements: 51.1, 51.2_
  - [x] 43.2 Add a per-host opt-out toggle in the options page; when set, skip layout-driven repositioning entirely. _Requirements: 51.3_

### Phase 25: Pin Clustering and Web Store Readiness (Reqs 52, 53)

- [x] 44. Pin clustering
  - [x] 44.1 Implement `PinClusterer` with a 2D bucket algorithm (default radius 24 px) that runs after every PinPositioner tick. _Requirements: 52.1_
  - [x] 44.2 Render a `<fl-cluster-pin>` Custom Element labeled with the count when a bucket holds ≥ 2 pins. _Requirements: 52.1_
  - [x] 44.3 On click, open a list popover showing the contained annotations; allow drilling into one. _Requirements: 52.2_
  - [x] 44.4 Re-run on zoom and layout changes; expand the cluster when pins no longer overlap. _Requirements: 52.3_
  - [x] 44.5 Property test: pin clustering is consistent. **Property 16**. _Validates: Requirements 52.1_

- [x] 45. Web Store readiness
  - [x] 45.1 Create `extension/store/` with `description-short.txt`, `description-long.md`, `screenshots/` (3 PNGs at 1280×800), `icon-128.png`, `privacy-policy.md`, `support-email.txt`. _Requirements: 53.1_
  - [x] 45.2 Add `extension/CHANGELOG.md` with a v0.1.0 entry. _Requirements: 53.3_
  - [x] 45.3 Confirm `manifest.json` `version` follows SemVer; update README with the release process. _Requirements: 53.2_

### Phase 26: V2 Stub

- [x] 46. Session Replay placeholder
  - [x] 46.1 Capture the V2-1 deferral note in `extension/CHANGELOG.md` (no implementation; flagged for V2). _Requirements: V2-1_

## Notes

- Existing tasks 1–18 from the prior implementation plan are preserved as completed work and listed under Phase 0 for traceability. They are not regenerated.
- React removal (tasks 17 and 18) is the most invasive change. Both clients can run the new and old implementations side-by-side behind the `VITE_FL_USE_LEGACY_REACT` flag described in the design during cutover; flip the flag per surface as each leaf component lands.
- No task creates files outside the four packages (`shared/`, `server/`, `dashboard/`, `extension/`) plus the repo root (`docker-compose.yml`, `.github/workflows/ci.yml`, `README.md`).
- A real PostgreSQL instance is required for two property tests (Property 12 — pin-numbering uniqueness under contention, Property 13 — shared-link lockout FSM). Use the `postgres:16` service container in CI.
- Test sub-tasks marked with `*` are optional and may be skipped for a faster MVP cut.
- Phases 14–26 add the new Extension capabilities from Requirements 32–53. Phase 22 (Offline Mode) introduces server-side idempotency on `client_request_id`, which the existing annotation/comment routes (touched by Phases 4 and 5) MUST be aware of when their handlers are extended; coordinate the migration order so 35.1 lands before 36.x.
- Phase 1.5 carves out the hexagonal layout (Req 54). Subsequent phases land into the new structure: Phase 2 migrations stay schema-only; Phase 3 auth code lands as use cases + adapters; Phase 4 page entity and atomic pin numbering land as `ProjectPinSequence` outbound port + `createAnnotation` use case; Phase 6 durable queue is the `NotificationQueue` port + `PgNotificationQueue` adapter + `dispatchPendingNotifications` use case + `notificationWorker` inbound adapter; Phase 9 `verifyLinkPassword` becomes a use case; Phase 22 offline idempotency hangs on `findByClientRequestId` on `AnnotationRepo` and `CommentRepo`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.5", "2.3", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "8.1"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "4.1", "9.2", "11.1", "13.1", "14.1", "15.1", "16.1", "17.1", "18.1", "18.2", "18.3", "20.1", "21.1"] },
    { "id": 2, "tasks": ["2.2", "4.2", "6.1", "9.1", "9.3", "13.2", "13.5", "15.2", "16.2", "17.3", "17.4", "17.5", "17.6", "18.4", "18.5", "18.6", "18.7", "18.10", "18.11", "18.12", "20.2"] },
    { "id": 3, "tasks": ["3.1", "6.2", "6.3", "6.4", "6.5", "9.4", "12.1", "13.3", "15.3", "17.2", "17.7", "18.13"] },
    { "id": 4, "tasks": ["3.2", "7.1", "7.5", "10.1", "11.2", "12.2", "13.4", "14.2", "14.3", "17.8"] },
    { "id": 5, "tasks": ["7.2", "7.3", "10.2", "14.4", "17.9", "18.8", "19.1"] },
    { "id": 6, "tasks": ["7.4", "8.2", "17.10", "17.11", "18.9", "18.14", "19.2", "19.3", "19.4", "19.5"] },
    { "id": 7, "tasks": ["18.15", "22.1"] },
    { "id": 8, "tasks": ["22.2", "22.3"] },
    { "id": 9, "tasks": ["23.1", "23.2", "23.3", "23.4", "23.5", "24.3", "25.1", "27.1", "35.1"] },
    { "id": 10, "tasks": ["24.1", "24.2", "24.4", "24.5", "24.6", "25.2", "25.3", "25.4", "25.5", "25.6", "25.7", "25.8", "26.1", "26.2", "26.3", "27.2", "27.3", "27.4", "27.5", "28.1", "28.2", "29.1", "29.2", "29.3", "29.4", "30.1", "30.2", "30.3", "31.1", "31.2", "31.3", "32.1", "32.2", "32.3", "33.1", "33.2", "33.3", "34.1", "34.2", "35.2", "36.1", "36.2", "36.3", "36.4", "36.5", "36.6", "36.7", "36.8", "36.9", "36.10", "37.1", "37.2", "37.3", "37.4", "38.1", "38.2", "38.3", "38.4", "39.1", "39.2", "39.3", "40.1", "40.2", "40.3", "40.4", "41.1", "41.2", "41.3", "42.1", "42.2", "43.1", "43.2", "44.1", "44.2", "44.3", "44.4", "44.5", "45.1", "45.2", "45.3", "46.1"] },
    { "id": 11, "tasks": ["4.5.1", "4.5.2", "4.5.3", "4.6.1", "4.6.2", "4.6.3"] },
    { "id": 12, "tasks": ["4.7.1", "4.7.2", "4.7.3", "4.7.4", "4.7.5", "4.7.6", "4.7.7", "4.7.8", "4.7.9", "4.7.10", "4.8.1", "4.8.2", "4.8.3", "4.8.4", "4.8.5", "4.8.6", "4.8.7", "4.8.8", "4.9.1", "4.9.2", "4.9.3", "4.10.1", "4.10.2", "4.11.1", "4.11.2", "4.11.3"] }
  ]
}
```
