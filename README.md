# Pinpoint — Setup & Usage Guide

A collaborative website feedback platform. Annotate live websites with your team using a Chrome Extension, manage projects and view analytics on the Web Dashboard.

## Architecture

```
pinpoint/
├── shared/       # TypeScript types, Zod schemas, theme, signals, UA parser
├── server/       # Node.js + Express + Socket.IO + PostgreSQL API (under /api/v1)
├── dashboard/    # Vanilla TypeScript + Vite + <template> + signal() + History API router
├── extension/    # Chrome Extension (Manifest V3) — Web Components in Shadow DOM
├── widget/       # Embeddable <script> feedback widget (served by the API at /widget/pinpoint-widget.js)
├── mcp-server/   # MCP server (stdio) over the REST API, authenticated with an org API key
└── e2e/          # Playwright suites: API, real dashboard UI, real MV3 extension
```

Both clients are React-free. The Dashboard renders by cloning `<template>` blocks
declared in `dashboard/index.html` and reactively binding them via the ~30-LOC
`signal<T>()` primitive shipped from `@pinpoint/shared`. The Extension is
composed of Custom Elements (`<fl-overlay-host>`, `<fl-popover>`,
`<fl-floating-toolbar>`, `<fl-sidebar-panel>`, `<fl-annotation-pin>`,
`<fl-mention-autocomplete>`, `<fl-comment-thread>`) attached to a single
Shadow Root, sharing one constructable stylesheet.

For details on the post-React migration, see [Migration Notes](#migration-notes)
below.

**More docs:** [Go-live plan](./docs/GO_LIVE_PLAN.md) (cheapest path, owner checklist) ·
[Deployment](./docs/DEPLOYMENT.md) · [Integrations setup](./docs/INTEGRATIONS_SETUP.md) ·
[Store submission](./docs/STORE_SUBMISSION.md) · [Security review](./docs/SECURITY_REVIEW.md) ·
[SOC 2 readiness](./docs/SOC2_READINESS.md) (gap assessment, **not** a compliance claim) ·
[Policy templates](./docs/compliance/README.md) ·
[Legal pack](./docs/legal/README.md) (draft Terms, [Privacy Policy](./docs/legal/PRIVACY_POLICY.md), [DPA](./docs/legal/DATA_PROCESSING_AGREEMENT.md), [Sub-processors](./docs/legal/SUBPROCESSORS.md), [Cookies](./docs/legal/COOKIE_POLICY.md), [Retention](./docs/legal/DATA_RETENTION.md), [Breach response](./docs/legal/BREACH_RESPONSE.md) — **not legal advice; lawyer review required**) · [Crash course](./docs/CRASH_COURSE.md) · [Contributing / engineering standard](./CONTRIBUTING.md)

---

## Quickstart

The fastest way to bring the whole stack up is the containerised dev setup
defined in `docker-compose.yml` (see design decision 14). One command starts
Postgres, runs all pending migrations to completion, then boots the API and
Dashboard.

### Prerequisites

- **Docker** 24+ (Docker Desktop on macOS/Windows, or the engine on Linux)
- **Docker Compose** v2 (bundled with modern Docker Desktop; `docker compose version`)
- **Node.js** 20 (only required if you want to run the Extension build, lint,
  or tests on the host outside of Docker). The `demo:*` / `docs:crash-course`
  scripts need **Node ≥ 22.18** (see [Demo workspace](#demo-workspace--test-data-cleanup)).

### One-command bootstrap

From the repository root:

```bash
docker compose up
```

When the stack is healthy:

- Dashboard → http://localhost:4173
- API → http://localhost:3001 (health probe at http://localhost:3001/health)
- Mail UI (Mailpit) → http://localhost:8025 — every email the API sends
  (verification, password reset, notifications) is captured here instead of
  being delivered. The API points `SMTP_HOST`/`SMTP_PORT` at the `mailpit`
  service by default.

The first `up` builds the API and Dashboard images and runs the `migrate`
service to completion before `api` starts; subsequent runs reuse the cached
images and the `db_data` volume.

How the Compose stack is wired (all of it is local-only by design):

- **Every published port is bound to `127.0.0.1`** (Postgres 5432, Redis 6379,
  Mailpit 1025/8025, API 3001, Dashboard 4173, Prometheus 9090, Grafana 3000),
  so nothing is reachable from other machines on your network.
- **The Dashboard and API share one origin.** The dashboard container runs
  `vite preview` on 4173 and proxies `/api`, `/socket.io`, `/widget` and the
  review-link frames (`/review/:linkId/frame`) to the API at
  `API_PROXY_TARGET` (`http://api:3001` in Compose). Cookies are therefore
  first-party and no CORS is involved. `npm run dev --workspace dashboard`
  (port 5173) uses the same proxy table, targeting `http://localhost:3001`
  unless `API_PROXY_TARGET` is set.
- **`COOKIE_INSECURE=true` and `PINPOINT_LOCAL_DEV=1` are set on the `api`
  service for the plain-HTTP loopback stack only.** The first drops the
  `Secure` flag from the session cookies (otherwise non-Chrome browsers
  discard them over `http://`); the second tells the boot preflight that the
  container's `HOST=0.0.0.0` bind is only published on loopback. Neither can
  weaken a `NODE_ENV=production` or `PINPOINT_SELF_HOST=1` deployment —
  `COOKIE_INSECURE=true` is rejected there. Remove both and set real secrets
  before exposing the stack (see [Self-hosting](#self-hosting)).

To stop the stack:

```bash
docker compose down           # stop containers, keep the database volume
docker compose down -v        # stop containers and wipe the database volume
```

### Optional monitoring profile

Prometheus and Grafana are defined behind a `monitoring` Compose profile, so a
plain `docker compose up` never starts them. Bring them up explicitly when you
want local observability:

```bash
docker compose --profile monitoring up
```

- Prometheus → http://localhost:9090
- Grafana → http://localhost:3000 (anonymous access enabled; admin login
  defaults to `admin`/`admin`, override via `GRAFANA_USER`/`GRAFANA_PASSWORD`)

The API exposes Prometheus metrics at `GET /metrics` (`prom-client`):
`http_requests_total` and `http_request_duration_seconds`, both labelled
`method` / `route` / `status` where `route` is the matched route *pattern*
(e.g. `/api/v1/projects/:id`, never the raw URL), plus the default Node
process metrics. Access control:

- If `METRICS_TOKEN` is set, callers must send
  `Authorization: Bearer $METRICS_TOKEN` (401 otherwise).
- If it is unset, only loopback / private-network callers are allowed (403
  from the public internet).

`infrastructure/monitoring/prometheus.yml` scrapes `api:3001/metrics` over the
private Compose network, so no token is needed locally. For any exposed
deployment set `METRICS_TOKEN` and uncomment the `authorization` block in that
file with the same value.

### Environment variables

`docker-compose.yml` ships with sensible development defaults, so plain
`docker compose up` works out of the box. Override any variable by exporting
it in your shell or placing it in a project-root `.env` file. The full list —
names, defaults and which workspace reads them — is in the single
[Environment variables reference](#10-environment-variables-reference) below.

For non-Docker workflows (running the API directly with `npm start`), the
server reads the same variables from `server/.env` — see the detailed setup
sections below.

### Loading the Chrome Extension

The Extension is built with `vite build` and `@crxjs/vite-plugin`, which emits
a loadable Manifest V3 bundle into `extension/dist/`:

```bash
npm run build --workspace extension
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on
3. Click **Load unpacked** and select **`extension/dist/`** (the built
   `manifest.json` lives there — do *not* select `extension/`)

Sign in from the toolbar popup (see [Install the Chrome Extension](#7-install-the-chrome-extension)).
To point the build at a non-default API, set `VITE_PINPOINT_API_ORIGIN` at
build time (default `http://localhost:3001`); users can also override the
origin at runtime with the **Server URL** option.

### Common dev commands

Run from the repository root:

```bash
npm run build      # build every workspace (shared, server, dashboard, extension, widget, mcp-server, …)
npm test           # run the Vitest suite (unit + property-based + integration tests)
npm run typecheck  # type-check the entire monorepo via tsc --build
npm run lint       # run ESLint across workspaces (server hex-boundary rules, etc.)
npm run migrate    # apply pending database migrations (server/knexfile.ts)
```

Per-workspace scripts (use `--workspace <name>` from the root, or `cd` into the
package and run them directly):

| Workspace | `npm run dev` | `npm run build` | `npm test` |
|---|---|---|---|
| `shared` | — | `tsc --build` | `vitest --run` |
| `server` | — (`npm start` after build) | `tsc --build` | `vitest --run` |
| `dashboard` | `vite` (port 5173) | `tsc --noEmit && vite build` | `vitest --run` |
| `extension` | `vite` (CRXJS, content-script HMR) | `vite build` → loadable MV3 bundle in `extension/dist/` | `vitest --run` |
| `widget` | — | `vite build` → `widget/dist/pinpoint-widget.js` | — (`npm run typecheck`: `tsc --noEmit`) |
| `mcp-server` | — | `tsc --build` | `vitest --run` |

The Dashboard's `npm run dev` launches Vite on port 5173 and proxies `/api`,
`/socket.io`, `/widget` and `/review/:linkId/frame` to the API
(`http://localhost:3001` unless `API_PROXY_TARGET` is set). The Extension's
`npm run dev` is `vite` with `@crxjs/vite-plugin`.

---

## Manual Setup (without Docker)

If you'd rather run each service directly on your host (useful when working on
the API or Dashboard internals), follow the steps below. The Quickstart above
is the recommended path for everyone else.

### Prerequisites

- **Node.js** 20+ and **npm** 10+ (`engines.node` is `>=20`; the optional demo/docs scripts need Node ≥ 22.18)
- **PostgreSQL** 14+ running locally (or a remote instance)
- **Google Chrome** (for the extension)

---

## 1. Install Dependencies

From the `pinpoint/` root:

```bash
npm install
```

This installs all workspace dependencies across shared, server, dashboard, and extension.

---

## 2. Set Up PostgreSQL

Create the database:

```bash
createdb pinpoint
```

Optionally create a test database:

```bash
createdb pinpoint_test
```

### Configure Environment Variables

Create `pinpoint/server/.env`:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=pinpoint
DB_USER=postgres
DB_PASSWORD=postgres

# Auth
JWT_SECRET=your-secret-key-change-in-production

# Server
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Email (placeholder — not required for dev)
APP_URL=http://localhost:5173
```

> **Note:** `CORS_ORIGIN` defaults differ by run mode — use
> `http://localhost:5173` when the Dashboard runs via `npm run dev --workspace
> dashboard` (Vite dev server) and `http://localhost:4173` when running via
> Docker Compose (`docker compose up`, which serves the production preview
> build on port 4173). Set whichever matches the origin your Dashboard is
> actually served from. The same applies to `APP_URL`.

### Run Database Migrations

```bash
npm run migrate --workspace server      # or: npm run migrate (from the repo root)
```

This applies every pending migration (`knex migrate:latest` against
`server/knexfile.ts`; the `development` profile is used unless `NODE_ENV` says
otherwise). It creates every table the API depends on: `users`, `projects`, `pages`,
`annotations`, `comments`, `teams`, `team_members`, `guidelines`,
`shared_links`, `auth_tokens` (formerly `password_resets`), and
`notifications` — with the supporting indexes including the JSONB index on
`annotations.environment->>'browserFamily'` used by the analytics aggregation.

---

## 3. Build the Shared Library

The shared package must be built first since server, dashboard, and extension depend on it:

```bash
cd pinpoint/shared
npm run build
```

---

## 4. Start the API Server

```bash
cd pinpoint/server
npm run build
npm start
```

The server starts on `http://localhost:3001` by default and logs a JSON line
(`"Pinpoint API server listening"`, with `port` and `host`). Verify it's running:

```bash
curl http://localhost:3001/health
# → {"status":"ok","checks":{"database":"ok","redis":"not_configured","s3":"configured"},
#    "info":{"version":"…","nodeVersion":"…","uptime":…,"memoryUsage":{…}}}
```

`/health` (and `/health/ready`) returns **HTTP 503** with
`"status":"unhealthy"` and `"checks":{"database":"error",…}` when the database
is unreachable; a failing optional dependency (Redis) yields `"degraded"` with
HTTP 200. `/health/live` is a cheap liveness probe that returns 503 only once
the process is shutting down.

---

## 5. Start the Web Dashboard

In a separate terminal:

```bash
cd pinpoint/dashboard
npm run dev
```

The dashboard starts on `http://localhost:5173`. Its Vite dev server proxies
`/api` (live `/api/v1` routes plus the legacy `/api/...` 410 redirect),
`/socket.io`, `/widget` and `/review/:linkId/frame` to the API
(`dashboard/vite.config.ts`), so the browser sees one origin.

> **Note:** If your API is not on `http://localhost:3001`, set
> `API_PROXY_TARGET` (e.g. `API_PROXY_TARGET=http://localhost:4000 npm run dev`).

---

## 6. Using the Web Dashboard

The dashboard is a vanilla TypeScript single-page app. Each route is a
`<template>` block in `dashboard/index.html` cloned and bound by the page
module under `dashboard/src/pages/` via the `signal<T>()` primitive from
`@pinpoint/shared`. Routing uses the History API
(`dashboard/src/lib/router.ts`).

### Register & Log In

1. Open `http://localhost:5173/auth`
2. Click "Register" and create an account (name, email, password — minimum 10
   characters, not in the common-passwords blocklist).
3. New accounts start unverified. Click the verification link in the email
   (or hit `POST /api/v1/auth/verify-email/:token` directly in dev). Until
   verification completes, login fails with `EMAIL_NOT_VERIFIED`.
4. After verifying, log in. The server sets the `fl_session` (HttpOnly) and
   `fl_csrf` (readable) cookies and returns `{ user, csrfToken, token }` in
   the response body. **The first successful login of a verified user with no
   organisation provisions a personal org** (idempotent, transactional) and
   makes them its owner; projects, annotations and comments are created
   under that org. Unverified users and wrong passwords never trigger
   provisioning.

Error codes you will meet: login returns `EMAIL_NOT_VERIFIED` (HTTP 403)
until the email is verified; `INVALID_PASSWORD` (HTTP 401) is returned by the
shared-link password check (`POST /api/v1/shared/:linkId/verify`), not by
account login.

### Create a Project

1. In the left sidebar, click **+ Create Project**
2. Enter a project name and one or more website URLs. Each URL becomes a
   `pages` row scoped to the project (Requirement 23).
3. The project appears in the sidebar under "Active".

### Manage Projects

Right-click any project (or click the ⋯ button) for the context menu:
- **Rename** — edit the project name inline
- **Archive / Unarchive** — move between Active and Archived tabs
- **Delete** — permanently remove (requires typing the project name to confirm)
- **Export project** — generate a PDF or CSV report of all annotations (CSV includes browser/OS columns)
- **Copy link** — copy the project URL to clipboard
- **Project details** — view annotation count, team members, metadata

### View Annotations

Click a project to open the project view:
- **List view** — table of all annotations with pin number, type, severity, status, body
- **Kanban view** — drag-and-drop cards between Open, In Progress, and Resolved columns
- **Analytics** — annotation counts grouped by severity, type, status, and browser family (`bySeverity`, `byType`, `byStatus`, `byBrowser`)

Click any annotation row to see details. Bug reports (type=note, severity=critical/major) show the captured `EnvironmentMetadata` (single-line summary plus expandable details) and allow assigning a team member from the project members dropdown plus a due date.

### Settings

Navigate to `/settings` for:
- **Profile** — update name, email, avatar URL
- **Notifications** — toggle email notifications per event type (new annotation, new comment, promoted to owner, project deleted)
- **Guidelines** — view Nielsen's 10 Heuristics (auto-seeded) and create custom guidelines
- **Teams** — create teams, invite members by email, change roles (Owner/Admin/Viewer), remove members

### Shared Links

Project owners can create password-protected shared links. Visitors at `/shared/:linkId` see a password prompt. After 3 wrong attempts from the same IP address, that visitor is locked out for 15 minutes (other visitors are not affected). Guest feedback on a password-protected link needs the same unlock.

### Client portals

A portal is a branded, read-only page for a client. Admins create/edit portals
at `/portals`; a guest enters their email on `/portal/:slug`, receives a 24 h
magic link (`/portal/:slug?token=…`) and sees the portal's title, welcome
message, brand colour and the project's feedback. The page strips the token from
the address bar, keeps it in memory only and never sends dashboard cookies.
The API has no guest submit endpoint for portals, so the page is read-only.

### Review links (no-install proxy)

Review links are the third page-reach mechanism (alongside the extension and
the `<script>` widget) — they let a reviewer leave feedback on a live site
**without installing anything**. The dashboard page `/review/:linkId` frames
the server-side proxy `/review/:linkId/frame` (the SPA owns `/review/:linkId`;
the proxy and the dashboard dev/preview server route only the `/frame` path
to the API) in a sandboxed iframe with a "Send feedback" overlay wired to the
existing guest feedback endpoint.

How it works and its honest limits:

- The server (`GET /review/:linkId/frame`, mounted outside `/api/v1`) fetches the
  target page **only** through the SSRF egress guard (`safeFetch`:
  https-only, DNS-pinned to a validated public IP, private/metadata ranges
  blocked, 10s timeout, 5 MB cap, `text/html` only, at most 3 redirects —
  each re-validated).
- It injects a `<base href>` pointing at the real origin, so **subresources
  (CSS/JS/images) load directly in the reviewer's browser from the origin** —
  Pinpoint does *not* proxy subresources (that would make it an open relay).
- A missing link and a feedback-disabled link return an identical 404;
  password-protected links aren't proxied (open them via `/shared/:linkId`).
- **Sites that send `X-Frame-Options` or a CSP `frame-ancestors` directive
  will refuse to render in the iframe**, and SPAs that render only after
  login show their logged-out shell — the proxy fetches the raw document
  anonymously and cannot (and must not) strip the origin's framing headers.


---

## 7. Install the Chrome Extension

The Extension is built from Web Components in a Shadow Root — Custom
Elements such as `<fl-overlay-host>`, `<fl-popover>`, `<fl-sidebar-panel>`,
`<fl-floating-toolbar>`, `<fl-annotation-pin>`, `<fl-mention-autocomplete>`,
and `<fl-comment-thread>`, all sharing one constructable stylesheet from
`@pinpoint/shared/theme`. There is no React on the client.

### Build the Extension

```bash
npm run build --workspace extension     # or: cd extension && npm run build
```

This runs `vite build` with `@crxjs/vite-plugin` and emits a loadable
Manifest V3 bundle (including the built `manifest.json`) into
`extension/dist/`. `npm run dev --workspace extension` runs `vite` with
content-script HMR. To bake a non-default API origin into the build, set
`VITE_PINPOINT_API_ORIGIN` (default `http://localhost:3001`).

### Load in Chrome (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the **`pinpoint/extension/dist/`** directory — not `extension/`
5. The Pinpoint icon appears in your toolbar

### Authentication

The Extension cannot share cookies with arbitrary host pages, so it
authenticates with a bearer JWT instead (Requirement 18.5):

1. Click the toolbar icon and **sign in from the popup** (email + password;
   the same `POST /api/v1/auth/login` the dashboard uses). Signing in via the
   Dashboard also works — the login response body returns `{ token }`
   alongside the cookies.
2. The Extension stores the token in `chrome.storage.local` under
   `pinpoint_auth_token` and sends `Authorization: Bearer <token>` on
   every API call from `extension/src/lib/api.ts`. Content scripts relay
   these calls through the background service worker (so the host page's
   CORS policy does not apply) — see
   [`extension/README.md`](./extension/README.md#networking-the-content-script--service-worker-api-relay).
3. Bearer-authenticated requests are CSRF-exempt (proof-of-possession);
   the dashboard cookie+CSRF middleware skips them.
4. Tokens are refreshed with a sliding window via `POST /api/v1/auth/refresh`
   when within five minutes of expiry.

### Using the Extension

1. Navigate to any website
2. Click the **Pinpoint icon** in the Chrome toolbar to toggle the overlay
3. The **Floating Toolbar** appears at the bottom center with buttons for close, share, and copy link
4. **Click any element** on the page to open the annotation popover
5. Choose a tab (Note / Suggestion / Guideline), select a severity, type your feedback, and click Submit
6. **Numbered pins** appear on the page at each annotation's position, color-coded by severity:
   - 🔴 Critical (red)
   - 🟠 Major (orange)
   - 🟡 Minor (yellow)
   - 🔵 Informational (blue)
7. Click a pin to view the annotation details and comment thread
8. Use **@mentions** in comments to notify team members
9. **Resolve/Reopen** annotations from the popover
10. The **Sidebar Panel** shows Active and Resolved tabs for the current project

### Keyboard Shortcuts

The extension binds four default shortcuts — `Alt+Shift+F` (toggle
overlay), `Alt+Shift+S` (toggle sidebar), `Alt+Shift+.` (next pin), and `Alt+Shift+,`
(previous pin). Users can remap them from `chrome://extensions/shortcuts`
(paste that URL into the Chrome address bar; `chrome://` links can't be
opened from a markdown file or page link). See
[`extension/README.md`](./extension/README.md#keyboard-shortcuts) for the
full table and the equivalent shortcut pages on Edge, Brave, Firefox, and
other browsers.

### Real-Time Collaboration

When multiple team members are on the same project:
- New annotations appear as pins instantly (no page refresh)
- Comments sync in real time
- Status changes (resolve/reopen) update for everyone
- A "Reconnecting…" indicator shows if the WebSocket connection drops

The Socket.IO `/collab` namespace authenticates each handshake with the
bearer JWT (`auth.token` — the extension, or a freshly logged-in dashboard
tab). A hard-refreshed dashboard tab has no in-memory bearer, so the
`fl_session` cookie is accepted **only when the handshake `Origin` is the
configured dashboard origin** (`CORS_ORIGIN`); a cookie from any other origin
is rejected (cross-site WebSocket hijacking guard). Room joins are authorised
by verifying the project belongs to the caller's org.

---

## 8. Run Tests

From the monorepo root:

```bash
npm test
```

This runs the full Vitest suite — unit tests, fast-check property tests
(including the round-trip serializer, the analytics aggregation invariant,
the pin-numbering uniqueness property under contention, the shared-link
lockout FSM, and the `parseUserAgent` totality property), Socket.IO
integration tests, and end-to-end flow tests (annotation broadcast,
@mention notification, shared-link lockout, durable notification queue
backoff). The pin-numbering and lockout tests need a real PostgreSQL
instance — Compose's `db` service is the easy path. Playwright E2E specs
live under `e2e/` and run with `npm run test --workspace e2e` once the
stack is up.

---

## 9. API Reference (Quick)

All endpoints are mounted under `/api/v1` (Requirement 25). Requests to the
legacy `/api/...` prefix return HTTP 410 with an `API_VERSION_REMOVED` error
envelope so old clients fail loudly.

Authentication has two shapes — pick the one that matches your client:

- **Dashboard** — `POST /api/v1/auth/login` issues an HttpOnly `fl_session`
  cookie plus a readable `fl_csrf` cookie (double-submit pattern, design
  decision 4). Subsequent requests carry the cookies via
  `credentials: 'include'`; mutating verbs (`POST` / `PUT` / `PATCH` /
  `DELETE`) must echo the CSRF token as `X-CSRF-Token`. The Dashboard never
  writes auth state to `localStorage`.
- **Extension** — the same login response also returns `{ token }` in the
  body. The Extension stores it in `chrome.storage.local` and sends
  `Authorization: Bearer <token>` on every API call. Bearer-authenticated
  requests are CSRF-exempt (proof-of-possession).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register (email, password, name); user starts unverified and receives a verification email |
| POST | `/api/v1/auth/verify-email/:token` | Mark the user verified |
| POST | `/api/v1/auth/resend-verification` | Re-issue the verification email |
| POST | `/api/v1/auth/login` | Login → cookies + `{ user, csrfToken, token }` |
| POST | `/api/v1/auth/logout` | Clear `fl_session` and `fl_csrf` cookies |
| POST | `/api/v1/auth/reset-password` | Request password reset |
| GET | `/api/v1/users/me` | Current user profile |
| PUT | `/api/v1/users/me` | Update profile. Changing `email` requires `currentPassword`; the new address is stored as `pending_email`, a confirmation link (`/verify-email/:token`) is mailed to it and a notice to the old address, and the login e-mail only changes (and all sessions are revoked) on confirmation |
| PUT | `/api/v1/users/me/notifications` | Update notification prefs |
| GET | `/api/v1/projects` | List projects (`?search=`, `?status=`) |
| POST | `/api/v1/projects` | Create project (accepts `{ name, urls: string[] }`) |
| GET | `/api/v1/projects/by-url?url=<encoded>` | Resolve a URL to `{ projectId, pageId }` |
| GET | `/api/v1/projects/:id` | Project details + annotation count |
| GET | `/api/v1/projects/:id/members` | List project members for the assignee dropdown |
| GET | `/api/v1/projects/:id/analytics` | Annotation analytics (`bySeverity`, `byType`, `byStatus`, `byBrowser`) |
| PUT | `/api/v1/projects/:id` | Rename / archive |
| DELETE | `/api/v1/projects/:id` | Delete (requires confirmationToken) |
| DELETE | `/api/v1/projects/:id/pages/:pageId?onNonEmpty=cascade\|block` | Delete a page; default `block` returns 409 when annotations exist |
| GET | `/api/v1/projects/:id/annotations` | List annotations (`?status=`) |
| POST | `/api/v1/projects/:id/annotations` | Create annotation (server assigns a unique pin number atomically) |
| PUT | `/api/v1/annotations/:id` | Update annotation |
| DELETE | `/api/v1/annotations/:id` | Delete annotation |
| PUT | `/api/v1/annotations/:id/status` | Change status |
| GET | `/api/v1/annotations/:id/comments` | List comments (chronological) |
| POST | `/api/v1/annotations/:id/comments` | Add comment |
| GET | `/api/v1/teams` | List user's teams |
| POST | `/api/v1/teams` | Create team |
| POST | `/api/v1/teams/:id/invite` | Invite member by email |
| PUT | `/api/v1/teams/:id/members/:userId` | Change member role |
| DELETE | `/api/v1/teams/:id/members/:userId` | Remove member |
| GET | `/api/v1/guidelines` | List guidelines |
| POST | `/api/v1/guidelines` | Create custom guideline |
| POST | `/api/v1/projects/:id/export` | Export PDF/CSV (CSV emits browser/OS columns) |
| POST | `/api/v1/projects/:id/share` | Create/update shared link |
| POST | `/api/v1/shared/:linkId/verify` | Verify shared link password (423 on lockout with `Retry-After`; 3 wrong attempts lock that visitor's IP for 15 min, not the whole link) |
| GET | `/api/v1/annotations/:id/screenshot` · `/markup` | Screenshot URL / Markup_Document of an annotation (org + project access enforced) |
| PATCH | `/api/v1/portals/:id` | Edit a client portal (`title`, `welcomeMessage`, `brandColor`, `logoUrl`, `active`; owner/admin; 404 for other orgs). Duplicate slug on create → 409 `SLUG_TAKEN` |

### Automation with org API keys

Scripts and agents (including the [MCP server](#mcp-server)) authenticate with
a **standard org API key** instead of a session:

- Create one with `POST /api/v1/api-keys` (JWT/cookie session required; the
  raw `pk_…` key is shown once). Standard keys default to the scopes
  `feedback:read` and `feedback:write`.
- Send it as `Authorization: Bearer pk_…`. Safe methods (`GET`/`HEAD`/`OPTIONS`)
  need `feedback:read`; mutations need `feedback:write`; otherwise the API
  answers 403 `INSUFFICIENT_SCOPE`. The request runs as the key's creator
  within the key's org.
- Keys are accepted **only** on the projects, annotations, comments and
  feedback routes (`/api/v1/projects`, `/api/v1/projects/:id/annotations`,
  `/api/v1/annotations`, `/api/v1/annotations/:id/comments`,
  `/api/v1/feedback`). Account, org-admin, billing, key-management,
  webhook and integration routes stay session/JWT-only, so a leaked
  automation key cannot mint keys or change org settings.
- Widget keys (`pk_widget_…`) are public, project-bound submission
  credentials and are always rejected as a Bearer token.

---

## 10. Environment Variables Reference

The single authoritative list. Every name and default below was verified
against the code that reads it: `server/src/composition/config.ts` (API
runtime), `server/src/config.ts` (boot preflight), `server/knexfile.ts`
(migrations), `server/src/adapters/inbound/http/widgetAsset.routes.ts`,
`dashboard/vite.config.ts` and `extension/vite.config.ts`. "Compose" notes
where `docker-compose.yml` overrides the code default. In the API, a value
that is unset or empty falls back to the default.

### Core / server

| Variable | Default | Read by | Description |
|----------|---------|---------|-------------|
| `NODE_ENV` | `development` | server | `development` / `test` / `production`. `production` engages the strict preflight and defaults `HOST` to `0.0.0.0`. |
| `PORT` | `3001` | server | API listen port. |
| `HOST` | `0.0.0.0` when `NODE_ENV=production`, else `localhost` | server | Interface to bind. A non-loopback value engages the strict preflight (unless `PINPOINT_LOCAL_DEV=1`). Compose sets `0.0.0.0`. |
| `CORS_ORIGIN` | `*` in code (**rejected on exposed deployments**); Compose: `http://localhost:4173` | server | Dashboard origin allowed by CORS (comma-separated list accepted for the cookie-authenticated socket origin check). Set explicitly in production. |
| `APP_URL` | `http://localhost:5173`; Compose: `http://localhost:4173` | server | Base URL embedded in outgoing emails (verification, password reset). |
| `LOG_LEVEL` | `info` (`silent` when `NODE_ENV=test`) | server | `pino` log level. |
| `API_RATE_LIMIT_MAX` | `100` | server | Per-IP request ceiling for `/api/*` per 15 minutes (minimum 1). Raise it for E2E runs from one machine. |
| `AUTH_RATE_LIMIT_IP_MAX` | `20` | server | Per-IP ceiling per minute on login/register/reset/verify endpoints, applied before the 5/min per (IP, email) and 30/15 min per-email limits. Raise it for E2E runs from one machine. |
| `TENANT_RATE_LIMIT_MAX` | `1000` | server | Requests per hour per organization (identified from the verified session/bearer). |
| `TRUST_PROXY` | `false` | server | Express `trust proxy` setting (`false`, `true`, a hop count like `1`, or a subnet list). Set to the number of proxies in front of the API (a single reverse proxy such as the bundled Caddy needs `1`) so rate limits and logs see the real client IP. `true` is rejected on exposed deployments. |
| `METRICS_TOKEN` | unset | server, preflight | If set, `GET /metrics` requires `Authorization: Bearer $METRICS_TOKEN` (401 otherwise). **Required (≥ 16 characters) on exposed deployments — the boot preflight exits 1 without it** (PP-07: behind a reverse proxy every caller has a private peer address). If unset on a local stack, only direct loopback/private-network callers are served; any request carrying `X-Forwarded-For`/`Forwarded` is refused (403). Generate with `openssl rand -base64 24`. |
| `PINPOINT_SELF_HOST` | unset | server preflight | `1` forces the strict preflight regardless of `NODE_ENV` / `HOST`. |
| `PINPOINT_LOCAL_DEV` | unset | server preflight | `1` asserts the stack is published on loopback only, so a `0.0.0.0` bind does not trigger the strict preflight. Never weakens `NODE_ENV=production` or `PINPOINT_SELF_HOST=1`. Set by Compose. |
| `COOKIE_INSECURE` | unset (`true` in Compose) | server | `true` drops the `Secure` flag from session cookies for plain-HTTP local stacks. **Rejected by the preflight on any exposed deployment.** |
| `WIDGET_DIST_DIR` | `<repo>/widget/dist` (relative to the compiled server); the server image sets `/app/widget/dist` | server | Directory the API serves `GET /widget/pinpoint-widget.js` from. A relative value is resolved against the working directory. |
| `NOTIFICATION_INTERVAL_MS` | `5000` | server | Poll interval of the durable notification worker. |
| `NOTIFICATION_BATCH_SIZE` | `10` | server | Notifications claimed per poll. |
| `DIGEST_ENABLED` | unset | server | `true` starts the daily-digest worker. |
| `BCRYPT_SALT_ROUNDS` | `10` | server | bcrypt cost factor. |

### Secrets and auth

| Variable | Default | Read by | Description |
|----------|---------|---------|-------------|
| `JWT_SECRET` | `dev-secret-change-in-production` | server | JWT signing secret. On an exposed deployment the preflight exits with code 1 if it is unset, empty, a known placeholder (`dev-secret`, `dev-secret-change-in-production`, `change-me`) or shorter than 32 bytes. |
| `JWT_ACCESS_TTL` | `24h` | server | Access-token lifetime. |
| `JWT_GRACE_WINDOW_SECONDS` | `604800` (7 days) | server | How long after expiry a token may still be refreshed via `POST /api/v1/auth/refresh`. |
| `OAUTH_STATE_SECRET` | unset | server preflight | HMAC key for the OAuth state cookie. Required on exposed deployments. |
| `INTEGRATION_ENCRYPTION_KEY` | stable dev-only derived key | server preflight | 32-byte key (base64 or 64-char hex) encrypting integration OAuth tokens and client secrets at rest. Required (real key) on exposed deployments. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | server | Enables Google OAuth when both are set. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | server | Enables GitHub OAuth when both are set. |
| `OAUTH_CALLBACK_BASE_URL` | `http://localhost:<PORT>` | server | Public origin used to build the Google/GitHub **sign-in** redirect URI (`<base>/api/v1/auth/oauth/<provider>/callback`). Set to your public https origin behind a proxy. |
| `INTEGRATION_{SLACK,JIRA,LINEAR,GITHUB,CLICKUP,ASANA}_CLIENT_ID` / `_CLIENT_SECRET` | unset | server | OAuth app credentials for the integration providers; a provider is enabled only when both are set (else `INTEGRATION_NOT_CONFIGURED` 501). Redirect URI is `${APP_URL}/api/v1/integrations/<provider>/callback`. See [`docs/INTEGRATIONS_SETUP.md`](./docs/INTEGRATIONS_SETUP.md). |
| `INTEGRATION_{SLACK,JIRA,LINEAR,GITHUB,CLICKUP,ASANA}_SCOPES` | provider default | server | Optional space/comma-separated scope override for that provider. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID` | unset | server | Billing is configured only when `STRIPE_SECRET_KEY` is set. |

### Database and cache

| Variable | Default | Read by | Description |
|----------|---------|---------|-------------|
| `DB_HOST` | `localhost` (Compose: `db`) | server, migrations | PostgreSQL host. |
| `DB_PORT` | `5432` | server, migrations | PostgreSQL port. |
| `DB_NAME` | `pinpoint` (`pinpoint_test` when `NODE_ENV=test`) | server, migrations | Database name. |
| `DB_USER` | `postgres` | server, migrations | Database user. |
| `DB_PASSWORD` | `postgres` | server, migrations | Database password. The preflight rejects the default `postgres` on exposed deployments. |
| `DB_APP_PASSWORD` | unset (Compose dev: `pinpoint-app-dev`) | migrations | Password for the unprivileged `pinpoint_app` role (`LOGIN NOSUPERUSER NOBYPASSRLS`) the API connects as so Row-Level Security applies (PP-08). The migration creates/updates the role when this is set; then run the API with `DB_USER=pinpoint_app` and `DB_PASSWORD=$DB_APP_PASSWORD`. Required by `deploy/docker-compose.prod.yml` (`install.sh` generates it). |
| `DB_MIGRATION_USER` / `DB_MIGRATION_PASSWORD` | `DB_USER` / `DB_PASSWORD` | migrations (`server/knexfile.ts`), demo scripts | Schema-owner credentials used by `npm run migrate` and the demo/cleanup scripts, so `DB_USER` can be the RLS-bound `pinpoint_app`. |
| `DB_POOL_MIN` / `DB_POOL_MAX` | `2` / `10` | server | Connection pool bounds. |
| `DATABASE_URL` | unset | migrations only | Optional connection string used **only** by the `production` profile of `server/knexfile.ts`; when unset it falls back to `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`. The API itself never reads it. |
| `REDIS_URL` | unset | server | Enables the Redis-backed rate limiter and Socket.IO adapter for multi-instance deployments. Compose: `redis://redis:6379`. |

### Email and storage

| Variable | Default | Read by | Description |
|----------|---------|---------|-------------|
| `SMTP_HOST` | `localhost` (Compose: `mailpit`) | server | SMTP host. |
| `SMTP_PORT` | `1025` (Compose: `1025`) | server | SMTP port. |
| `SMTP_SECURE` | `false` | server | `true` uses TLS from connect (typically port 465). |
| `SMTP_USER` / `SMTP_PASSWORD` | unset | server | SMTP credentials (optional). |
| `SMTP_FROM` | `no-reply@pinpoint.local` | server | From address. |
| `STORAGE_DRIVER` | `s3` if `S3_ENDPOINT` or `AWS_ACCESS_KEY_ID` is set, else `local` | server | `local` stores screenshots on disk (no provider needed); `s3` uses an S3-compatible bucket. |
| `LOCAL_STORAGE_DIR` | `./var/screenshots` (`/data/screenshots` in the image) | server | Directory for the `local` driver (created 0700). Must be absolute on exposed deployments; mount a volume there. Screenshots are served via 15-minute signed `/api/v1/screenshots/:token` URLs. |
| `S3_BUCKET` | `pinpoint` | server | Bucket for screenshots (`s3` driver). |
| `S3_REGION` | `us-east-1` (the SDK's `AWS_REGION` is also honoured) | server | Bucket region (`auto` for Cloudflare R2). |
| `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` / `S3_PUBLIC_BASE_URL` | unset / `false` / unset | server | S3-compatible storage (MinIO, etc.) options. Use `S3_FORCE_PATH_STYLE=true` with MinIO. The bucket is expected to be **private**: `GET /api/v1/annotations/:id/screenshot` returns a short-lived (15 min) presigned URL that the browser can load directly, so `S3_ENDPOINT` must be reachable from the user's browser. Set `S3_PUBLIC_BASE_URL` (CDN / public bucket) to get plain `<base>/<key>` URLs instead. |
| `PINPOINT_IMG_ORIGINS` | unset | dashboard (preview server) | Comma-separated extra **https** origins the dashboard CSP allows images from (e.g. avatar hosts). `S3_ENDPOINT` / `S3_PUBLIC_BASE_URL` origins are added automatically. Other external avatars fall back to initials and portal logos are hidden, so third-party image hosts never see dashboard users. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | server | Credentials for the bucket (the standard AWS SDK provider chain; for MinIO use its root/service-account key). Without resolvable credentials screenshot uploads fail with 503 `UNAVAILABLE`. |
| `S3_KEY_PREFIX` | `annotations/screenshots` | server | Object key prefix. |

### Client builds and dev servers

| Variable | Default | Read by | Description |
|----------|---------|---------|-------------|
| `API_PROXY_TARGET` | `http://localhost:3001` (Compose: `http://api:3001`) | dashboard `vite` dev and `vite preview` | API origin that `/api`, `/socket.io`, `/widget` and `/review/:linkId/frame` are proxied to, keeping dashboard and API on one origin. |
| `VITE_PINPOINT_API_ORIGIN` | `http://localhost:3001` | extension build | Build-time default API origin baked into the extension; a user-set **Server URL** takes precedence at runtime. |

Variables that only exist for E2E runs (`FL_API_URL`, `FL_APP_URL`,
`FL_E2E_EMAIL`, `FL_E2E_PASSWORD`) are documented in
[`e2e/README.md`](./e2e/README.md); the MCP server's `PINPOINT_API_URL` /
`PINPOINT_API_KEY` in [`mcp-server/README.md`](./mcp-server/README.md).

---

## Migration Notes

This section captures the major shifts in the architecture since the original
React-based prototype. New contributors and folks coming back after a long
absence should read this once.

### React removed from both clients (Requirement 31)

- **Dashboard** — vanilla TypeScript with `<template>` cloning, History-API
  routing (`dashboard/src/lib/router.ts`), and a 30-line `signal<T>()`
  reactive primitive shipped from `@pinpoint/shared`. CSS Modules ride
  on top of Vite's defaults. `react`, `react-dom`, `react-router-dom`,
  `@types/react`, `@types/react-dom`, and `@vitejs/plugin-react` are gone
  from `dashboard/package.json`. Build the dashboard with
  `npm run build --workspace dashboard` and develop with
  `npm run dev --workspace dashboard` (Vite on port 5173).
- **Extension** — Web Components (Custom Elements with Shadow DOM). One
  element per UI piece — `<fl-overlay-host>`, `<fl-popover>`,
  `<fl-floating-toolbar>`, `<fl-sidebar-panel>`, `<fl-annotation-pin>`,
  `<fl-mention-autocomplete>`, `<fl-comment-thread>` — backed by a single
  constructable stylesheet imported from `@pinpoint/shared/theme`. No
  React, no `@vitejs/plugin-react`. The build is `vite build` via
  `@crxjs/vite-plugin`, which emits the loadable MV3 bundle in
  `extension/dist/`.

### Cookie + CSRF for the Dashboard (Requirement 18)

`POST /api/v1/auth/login` sets two cookies on the dashboard origin:

- `fl_session` — HttpOnly, Secure, `SameSite=Lax`. The JWT, not readable
  from JavaScript.
- `fl_csrf` — readable, `SameSite=Lax`. The double-submit token.

The dashboard fetches every endpoint with `credentials: 'include'`. For
mutating verbs (`POST`/`PUT`/`PATCH`/`DELETE`) it echoes the CSRF token via
the `X-CSRF-Token` header; the server middleware
(`server/src/middleware/csrf.ts`) requires `header == cookie` or the request
is rejected. The dashboard never touches `localStorage` for auth — the
token captured from the login response body is held in a module-level
variable in `dashboard/src/lib/auth.ts` purely so the Socket.IO handshake
can authenticate.

`POST /api/v1/auth/logout` clears both cookies. Reading auth state on the
client uses `getIsAuthed()` (synchronous; reflects whether a CSRF token is
in memory) and `probeIsAuthed()` (asynchronous; consults
`GET /api/v1/users/me`).

### Bearer JWT for the Extension (Requirements 18.5, 33)

The Extension can't share cookies with arbitrary host pages, so the same
login response also returns `{ token }` in the body. The Extension stashes
it in `chrome.storage.local` under `pinpoint_auth_token` and sends
`Authorization: Bearer <token>` from `extension/src/lib/api.ts`. Bearer
requests are CSRF-exempt because the bearer is itself proof of possession.

Sliding-window refresh (`POST /api/v1/auth/refresh`, 7-day post-`exp` grace,
configurable via `JWT_GRACE_WINDOW_SECONDS`) and the in-extension popup login
surface are both implemented.

### `/api/v1` API base (Requirement 25)

Every server route — auth, users, projects, annotations, comments, teams,
guidelines, shared, exports, analytics — is mounted under `/api/v1`. A
catch-all on `/api/*` returns HTTP 410 with the `API_VERSION_REMOVED` error
envelope so any old `/api/...` clients fail loudly with a `newPath` hint.
Both clients share a single `API_BASE = '/api/v1'` constant
(`dashboard/src/lib/api.ts`, `extension/src/lib/api.ts`).

### Other foundational shifts worth knowing

- **`pages` entity (Requirement 23)** — projects now have one or more pages.
  `POST /api/v1/projects` accepts `{ name, urls: string[] }` and creates a
  `pages` row per URL. Annotations reference a `page_id` instead of a free
  `page_url`. `GET /api/v1/projects/by-url?url=<encoded>` resolves a URL to
  `{ projectId, pageId }`.
- **Atomic pin numbering (Requirement 24)** — a per-project `pin_counter`
  column on `projects` is incremented inside the same transaction as the
  annotation insert, killing the race that the old in-process counter had.
- **Browser detection on every annotation (Requirement 17)** — every create
  call carries an `environment` payload populated by
  `parseUserAgent(navigator.userAgent)` (with Brave/Arc overrides). Render
  surfaces and PDF/CSV exports include a single-line summary plus the full
  `EnvironmentMetadata`.
- **Tenant isolation is enforced twice** — in the application layer (every
  repository query and `access.ts` check is scoped by `org_id`; covered by the
  tenant-isolation integration tests) **and** by PostgreSQL Row-Level Security
  (migration `20261125000101_row_level_security.ts`, finding PP-08). The API
  connects as the unprivileged `pinpoint_app` role (`NOSUPERUSER NOBYPASSRLS`);
  every pooled connection is stamped with `app.current_org_id` / `app.system`
  from an `AsyncLocalStorage` tenant context
  (`server/src/infrastructure/tenantContext.ts`). With no context every policy
  fails closed (zero rows). Only server code can enter the `system` context
  (workers, login, public-id shared links / widget / portals / review links).
  Migrations run as the schema owner via `DB_MIGRATION_USER` /
  `DB_MIGRATION_PASSWORD`, which also creates `pinpoint_app` from
  `DB_APP_PASSWORD`. The policy table is in `docs/SECURITY_REVIEW.md` (PP-08).
- **Durable notification queue (Requirement 28)** — every email goes
  through the `notifications` table (`pending` → `sent` / `failed`); a
  worker uses `SELECT … FOR UPDATE SKIP LOCKED` and exponential backoff
  capped at 32 minutes. Boot replay is implicit because the poller picks
  up any `status='pending'` rows whose `scheduled_at` has passed.
- **Structured logging (Requirement 27)** — `pino` + `pino-http` emit one
  JSON record per request (request_id, method, path, status, latency_ms)
  and one per error. `console.*` is gone from server code.
- **Email verification (Requirement 20)** — register now creates the user
  with `verified=false`, login is rejected with `EMAIL_NOT_VERIFIED` until
  `POST /api/v1/auth/verify-email/:token` succeeds.
- **Shared theme (Requirement 26)** — `@pinpoint/shared/theme` exports
  `SEVERITY_COLORS`, `STATUS_LABELS`, `themeCss()`, and a constructable
  `sharedStyleSheet`. The Dashboard injects `themeCss()` into a `<style>`
  tag at boot; the Extension adopts the stylesheet on every Shadow Root.

---

## Demo workspace & test-data cleanup

Scripts for a realistic demo workspace and for tidying a **local** database after
test runs. They are plain Node ESM scripts (`scripts/*.mts`) that rely on Node
type stripping, so they need **Node.js ≥ 22.18** (the rest of the monorepo still
runs on Node ≥ 20).

```bash
npm run demo:seed                          # create whatever is missing (idempotent, safe to re-run)
npm run demo:reset                         # delete ONLY demo-owned data, then seed again
npm run demo:clean-test-data               # dry run: list leftover e2e/test projects that would be removed
npm run demo:clean-test-data -- --yes      # actually delete them
npm run docs:crash-course                  # render docs/CRASH_COURSE.md → .html and docs/crash-course/CRASH_COURSE.pdf
```

- **Login after seeding:** `maya.chen@acmestudio.dev` / `Sunr1se-Studio-Demo!`
  (owner, Pro plan). Teammate: `daniel.okafor@acmestudio.dev` with the same
  password. The seed also creates two projects, a team, share links (one
  password-protected), two client portals, automation rules, SLA policies and a
  widget key, and prints all links.
- **Environment:** `PINPOINT_API_URL` (default `http://127.0.0.1:3001`),
  `PINPOINT_APP_URL` (default `http://localhost:5173`; used for printed links
  only) and `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`
  (same variables as the server; defaults target a local `pinpoint` database).
  The seeder talks to a **running API** for everything the public API can do and
  to Postgres for the steps the API deliberately cannot (marking users verified,
  switching a plan, backdating timestamps, SLA breaches).
- **Local-DB-only guard:** every script that writes to the database refuses to
  run unless `DB_HOST` is `127.0.0.1`/`localhost` and `DB_NAME` is `pinpoint` or
  `pinpoint_test`. `demo:reset` only touches organisations owned by an
  `@acmestudio.dev` user and those users; `demo:clean-test-data` only deletes
  projects that are owned by the e2e seed account or an `*@example.test` user
  **and** match a known test-name pattern, and skips anything created in the last
  15 minutes (`--min-age-minutes=N` to change that).
- `docs:crash-course` renders the PDF with Playwright's Chromium; pass
  `-- --no-pdf` for HTML only.

---

## Release Process

The Pinpoint Chrome Extension ships through the Chrome Web Store. Releases
are cut from `main` after CI is green, version-stamped in `extension/manifest.json`,
and published as a zipped `dist/` upload through the developer dashboard.

### Versioning — SemVer

The extension follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
with the standard `MAJOR.MINOR.PATCH` shape (e.g. `0.1.0`):

- **MAJOR** — breaking permission changes (new `permissions` or
  `host_permissions` entries that require user re-consent, or removals that
  break installed clients).
- **MINOR** — new features that don't change the permission surface
  (additional commands, new overlay capabilities, new UI surfaces).
- **PATCH** — bug fixes, copy tweaks, and other backwards-compatible
  changes that ship without altering the feature set.

Chrome's manifest format also accepts shorter `MAJOR.MINOR` strings, but the
project's policy is to always pin a 3-part SemVer in
`extension/manifest.json` so the value lines up with the changelog and the
git tag.

### Release steps

1. **Bump the version in `extension/manifest.json`.** Update the `version`
   field to the new 3-part SemVer (e.g. `0.2.0`). This is the value Chrome
   displays in the Web Store listing and on `chrome://extensions`.
2. **Update `extension/CHANGELOG.md`.** Promote the `[Unreleased]` section
   into a dated entry — `## [X.Y.Z] - YYYY-MM-DD` — and list every notable
   change under the appropriate Keep-a-Changelog heading (Added, Changed,
   Deprecated, Removed, Fixed, Security). Open a fresh `[Unreleased]`
   block above it for the next cycle.
3. **Build the production bundle.** From `extension/`, run
   `npm run build`. The output lands in `extension/dist/` and is the
   directory Chrome's MV3 loader (and the Web Store) expects.
4. **Zip the `dist/` directory.** Create the upload archive from the
   contents of `dist/` — for example
   `cd extension/dist && zip -r ../pinpoint-extension-X.Y.Z.zip .`.
   Zip the contents, not the parent folder, so the manifest sits at the
   archive root.
5. **Upload to the Chrome Web Store.** Sign in to the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open the Pinpoint listing, attach the new zip as the next package
   version, refresh the listing copy and screenshots from
   `extension/store/` if anything changed, then submit for review.
6. **Tag the git release.** Once the upload is accepted, tag the commit
   that produced the bundle: `git tag extension-vX.Y.Z && git push origin
   extension-vX.Y.Z`. Use the same `X.Y.Z` as `manifest.json` and the
   `CHANGELOG.md` entry.

### Privacy policy and store listing

The Web Store listing copy, long description, screenshots, icon, support
email, and the user-facing privacy policy all live under
[`extension/store/`](./extension/store/) (created in task 45.1 of the
implementation plan):

- `description-short.txt` — the 132-character store summary.
- `description-long.md` — the long description rendered on the listing
  page.
- `screenshots/` — three 1280×800 PNGs used for the gallery.
- `icon-128.png` — the listing icon.
- `privacy-policy.md` — the privacy policy linked from the listing; host
  it (or its rendered HTML form) at a stable URL and paste that URL into
  the dashboard's privacy disclosures step on every release.
- `support-email.txt` — the contact email shown on the listing.

Refresh whichever of those assets changed in the release before submitting,
and keep them in lockstep with the `CHANGELOG.md` entry so reviewers and
users see the same story.

---

## MCP server

The `mcp-server/` workspace (`@pinpoint/mcp-server`) is a
[Model Context Protocol](https://modelcontextprotocol.io) server that lets
MCP-capable agents triage Pinpoint feedback. It is a thin, stateless client
over the existing REST API — no database, no new infrastructure.

Tools (few, deep): `list_projects`, `list_feedback` (status/severity filters +
pagination), `get_feedback` (item + comments + diagnostics),
`update_feedback_status`, `add_comment`.

Authentication uses a **standard org API key** (`pk_…`) sent as
`Authorization: Bearer <key>`. Widget keys (`pk_widget_…`) are rejected
client-side with a clear error — they are public submission credentials, not
management credentials.

```bash
npm run build --workspace @pinpoint/mcp-server
PINPOINT_API_URL="https://pinpoint.example.com" \
PINPOINT_API_KEY="pk_xxxxxxxx" \
  node mcp-server/dist/index.js      # speaks MCP (JSON-RPC 2.0) over stdio
```

The MCP wire protocol (`initialize` / `tools/list` / `tools/call`) is
implemented by hand (no `@modelcontextprotocol/sdk` dependency) so the leaf
workspace stays dependency-free; see
[`mcp-server/README.md`](./mcp-server/README.md) for the rationale and a sample
Claude Desktop config.

---

## Self-hosting

Pinpoint is safe to run on your own infrastructure, but a self-hosted
deployment reachable from a network other than localhost MUST supply real
secrets. The server runs a **config preflight** at boot (`validateConfig` in
`server/src/config.ts`, Mission A9) that refuses to start with dev-grade
defaults once the deployment is considered *exposed*.

### When the strict preflight runs

The preflight engages when ANY of these hold:

- `NODE_ENV=production`, or
- `PINPOINT_SELF_HOST=1` (explicit opt-in for self-hosters), or
- the server binds a **non-loopback** host — `HOST` set to anything other
  than unset / `localhost` / `127.0.0.1` / `::1` (e.g. `0.0.0.0`).

`HOST` defaults to `0.0.0.0` under `NODE_ENV=production` (so the container is
reachable) and `localhost` otherwise (so a plain `npm start` on a dev box is
never exposed). A production container binding `0.0.0.0` is already in strict
mode via `NODE_ENV`, so the HOST rule only adds coverage for the
misconfigured "dev build exposed to the internet" case.

If the checks pass, the server prints a one-line-per-secret **boot report**
classifying each required secret as `present` / `default` / `missing` — it
never prints the secret values.

### What the preflight rejects

On an exposed deployment the server exits with code 1 if:

| Check | Fails when |
|---|---|
| `JWT_SECRET` | unset, empty, a known placeholder, or shorter than 32 bytes (256 bits) |
| `CORS_ORIGIN` | unset or `*` (a wildcard allows any site to make credentialed requests) |
| `COOKIE_INSECURE` | `true` (session cookies would lose the `Secure` flag) |
| `DB_PASSWORD` | the default `postgres` |
| `OAUTH_STATE_SECRET` | unset/empty (signs the OAuth state cookie) |
| `INTEGRATION_ENCRYPTION_KEY` | unset, empty, or not decoding to exactly 32 bytes (base64 or 64-char hex) |
| `METRICS_TOKEN` | unset, empty or shorter than 16 characters |

### Required secrets for a self-hosted deployment

| Secret | Required when exposed | Format | Notes |
|---|---|---|---|
| `JWT_SECRET` | yes | ≥32-byte string | Signs session JWTs. Generate with `openssl rand -base64 48`. |
| `CORS_ORIGIN` | yes | URL | The exact dashboard origin, e.g. `https://feedback.example.com`. No wildcard. |
| `DB_PASSWORD` | yes | string | Must not be `postgres`. |
| `OAUTH_STATE_SECRET` | yes | string | HMAC key for the OAuth state cookie. |
| `INTEGRATION_ENCRYPTION_KEY` | yes | 32-byte base64 or 64-char hex | AES-256-GCM key encrypting integration OAuth tokens, client secrets **and webhook signing secrets** at rest. Generate with `openssl rand -base64 32`. |
| `HOST` | optional | host/IP | Interface to bind. Defaults to `0.0.0.0` in prod, `localhost` otherwise. |
| `PINPOINT_SELF_HOST` | optional | `1` | Force strict preflight regardless of `NODE_ENV`/`HOST`. |
| `PINPOINT_LOCAL_DEV` | no | `1` | Loopback-only local stacks (Compose). Skips the HOST-based trigger only; never weakens `NODE_ENV=production` / `PINPOINT_SELF_HOST=1`. |
| `METRICS_TOKEN` | yes | string (≥ 16 chars) | Bearer token for `GET /metrics`. Required on exposed deployments (PP-07); `openssl rand -base64 24`. |
| `COOKIE_INSECURE` | no | — | Leave unset on any exposed deployment. |

`deploy/docker-compose.prod.yml` is a ready-made, provider-neutral production
stack (Postgres, Redis, migrations, API, dashboard and Caddy with automatic
HTTPS) that sets `NODE_ENV=production` and reads every secret above from
`deploy/.env.production` (template: `deploy/.env.production.example`, with the
generation commands). For first deploy, upgrades, backups/restore, monitoring,
the pre-deploy checklist and reverse-proxy requirements see
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Troubleshooting

**"Connection refused" on API calls from dashboard**
→ Make sure the server is running on port 3001. The Vite proxy in `dashboard/vite.config.ts` forwards `/api` to `http://localhost:3001` (the same origin handles both `/api/v1` traffic and the legacy `/api` 410 redirect).

**Database migration fails**
→ Ensure PostgreSQL is running and the `pinpoint` database exists. Check credentials in `.env`.

**`API_VERSION_REMOVED` (HTTP 410) responses**
→ A client is hitting `/api/...` instead of `/api/v1/...`. Update the client's API base; both `dashboard/src/lib/api.ts` and `extension/src/lib/api.ts` already export `API_BASE = '/api/v1'`.

**`EMAIL_NOT_VERIFIED` on login**
→ Newly-registered accounts are unverified by default (Requirement 20). Either click the verification link in the email or hit `POST /api/v1/auth/verify-email/:token` directly. Use `POST /api/v1/auth/resend-verification` to re-issue the email.

**Server refuses to start with `JWT_SECRET` error**
→ In `NODE_ENV=production`, `validateConfig()` rejects unset/empty/`dev-secret`/`dev-secret-change-in-production`/`change-me` values for `JWT_SECRET` and exits with code 1 (Requirement 21). Set a real secret.

**Extension doesn't load in Chrome**
→ Make sure Developer mode is enabled and that you selected **`extension/dist/`** (not `extension/`). If `dist/` is missing or stale, run `npm run build --workspace extension` (`vite build` via `@crxjs/vite-plugin`).

**WebSocket connection fails**
→ The Socket.IO server runs on the same port as the API (3001); the Dashboard reaches it through its `/socket.io` proxy. A hard-refreshed dashboard tab authenticates with the `fl_session` cookie, which the server accepts only when the handshake `Origin` equals `CORS_ORIGIN` — make sure `CORS_ORIGIN` is exactly the origin the Dashboard is served from.

**Session cookie dropped on `http://` (non-Chrome browsers)**
→ Cookies carry the `Secure` flag by default. On a plain-HTTP loopback stack set `COOKIE_INSECURE=true` (Compose already does); the boot preflight rejects it on any exposed deployment.
