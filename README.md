# Pinpoint — Setup & Usage Guide

A collaborative website feedback platform. Annotate live websites with your team using a Chrome Extension, manage projects and view analytics on the Web Dashboard.

## Architecture

```
pinpoint/
├── shared/       # TypeScript types, Zod schemas, theme, signals, UA parser
├── server/       # Node.js + Express + Socket.IO + PostgreSQL API (under /api/v1)
├── dashboard/    # Vanilla TypeScript + Vite + <template> + signal() + History API router
└── extension/    # Chrome Extension (Manifest V3) — Web Components in Shadow DOM
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
  or tests on the host outside of Docker)

### One-command bootstrap

From the repository root:

```bash
docker compose up
```

When the stack is healthy:

- Dashboard → http://localhost:4173
- API → http://localhost:3001 (health probe at http://localhost:3001/health)

The first `up` builds the API and Dashboard images and runs the `migrate`
service to completion before `api` starts; subsequent runs reuse the cached
images and the `db_data` volume.

To stop the stack:

```bash
docker compose down           # stop containers, keep the database volume
docker compose down -v        # stop containers and wipe the database volume
```

### Environment variables

`docker-compose.yml` ships with sensible development defaults, so plain
`docker compose up` works out of the box. Override any of the following by
exporting them in your shell or placing them in a project-root `.env` file:

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-in-production` | **Change this for any non-local deployment.** Used to sign session JWTs. |
| `CORS_ORIGIN` | `http://localhost:4173` | Origin allowed by the API CORS layer; should match where the Dashboard is served. |
| `APP_URL` | `http://localhost:4173` | Base URL embedded in outgoing emails (verification, password reset). |
| `DB_NAME` | `pinpoint` | Postgres database name. |
| `DB_USER` | `postgres` | Postgres user. |
| `DB_PASSWORD` | `postgres` | Postgres password. |
| `DB_HOST` / `DB_PORT` | `db` / `5432` | Inside Compose, the API talks to the `db` service hostname; only override when running the API outside Docker. |

For non-Docker workflows (running the API directly with `npm start`), the
server reads the same variables from `server/.env` — see the detailed setup
sections below.

### Loading the Chrome Extension

The Extension currently ships a placeholder `tsc --build` output under
`extension/dist/` so the TypeScript compiles cleanly, but Manifest V3 needs
bundled assets to load. Once Phase 14 lands the `@crxjs/vite-plugin` toolchain
(design decision 15), `npm run build --workspace extension` will emit a
Web-Store-ready bundle into `extension/dist/`. After that, load it in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on
3. Click **Load unpacked** and select `extension/dist/`

Until CRXJS lands, treat the Extension dev flow as build-only — the file paths
remain the same, so the load step won't change.

### Common dev commands

Run from the repository root:

```bash
npm run build      # build every workspace (shared, server, dashboard, extension)
npm test           # run the Vitest suite (unit + property-based tests)
npm run typecheck  # type-check the entire monorepo via tsc --noEmit
npm run lint       # run ESLint across workspaces (server hex-boundary rules, etc.)
```

Per-workspace scripts (use `--workspace <name>` from the root, or `cd` into the
package and run them directly):

| Workspace | `npm run dev` | `npm run build` | `npm test` |
|---|---|---|---|
| `shared` | — | `tsc --build` | `vitest --run` |
| `server` | — (`npm start` after build) | `tsc --build` | `vitest --run` |
| `dashboard` | `vite` (port 5173) | `tsc --noEmit && vite build` | `vitest --run` |
| `extension` | — (build-only until CRXJS) | `tsc --build` | `vitest --run` |

The Dashboard's `npm run dev` launches Vite on port 5173 with `/api` proxied to
`http://localhost:3001`; once Phase 14 lands the Extension dev flow becomes
`npm run dev --workspace extension` powered by `@crxjs/vite-plugin`.

---

## Manual Setup (without Docker)

If you'd rather run each service directly on your host (useful when working on
the API or Dashboard internals), follow the steps below. The Quickstart above
is the recommended path for everyone else.

### Prerequisites

- **Node.js** 18+ and **npm** 9+
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
cd pinpoint/server
npx knex migrate:latest --knexfile knexfile.ts
```

This creates every table the API depends on: `users`, `projects`, `pages`,
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

The server starts on `http://localhost:3001` by default. You should see:

```
Pinpoint API server listening on port 3001
```

Verify it's running:

```bash
curl http://localhost:3001/health
# → {"status":"ok"}
```

---

## 5. Start the Web Dashboard

In a separate terminal:

```bash
cd pinpoint/dashboard
npm run dev
```

The dashboard starts on `http://localhost:5173`. It proxies `/api` requests
to the API server at `localhost:3001` (configured in `vite.config.ts`); the
proxy covers both the live `/api/v1` routes and the legacy `/api/...` 410
redirect.

> **Note:** If your API runs on a different port, update the proxy target
> in `dashboard/vite.config.ts`.

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
   the response body.

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

Project owners can create password-protected shared links. Visitors at `/shared/:linkId` see a password prompt. After 3 wrong attempts, access locks for 15 minutes.

---

## 7. Install the Chrome Extension

The Extension is built from Web Components in a Shadow Root — Custom
Elements such as `<fl-overlay-host>`, `<fl-popover>`, `<fl-sidebar-panel>`,
`<fl-floating-toolbar>`, `<fl-annotation-pin>`, `<fl-mention-autocomplete>`,
and `<fl-comment-thread>`, all sharing one constructable stylesheet from
`@pinpoint/shared/theme`. There is no React on the client.

### Build the Extension

```bash
cd pinpoint/extension
npm run build
```

Today this runs `tsc --build` and emits per-file output into
`extension/dist/`. Manifest V3 will load the directory as-is once
Phase 14's `@crxjs/vite-plugin` toolchain (design decision 15) lands; that
swap turns the script into `vite build` and the dev script into `vite`.

### Load in Chrome (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `pinpoint/extension/` directory
5. The Pinpoint icon appears in your toolbar

### Authentication

The Extension cannot share cookies with arbitrary host pages, so it
authenticates with a bearer JWT instead (Requirement 18.5):

1. Sign in once via the Dashboard. The login response body returns
   `{ token }` alongside the cookies.
2. The Extension stores the token in `chrome.storage.local` under
   `pinpoint_auth_token` and sends `Authorization: Bearer <token>` on
   every API call from `extension/src/lib/api.ts`.
3. Bearer-authenticated requests are CSRF-exempt (proof-of-possession);
   the dashboard cookie+CSRF middleware skips them.

Sliding-window refresh and an in-extension popup login surface land in
Phase 15.

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
overlay), `Alt+Shift+S` (toggle sidebar), `Alt+]` (next pin), and `Alt+[`
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
| PUT | `/api/v1/users/me` | Update profile |
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
| POST | `/api/v1/shared/:linkId/verify` | Verify shared link password (423 on lockout with `Retry-After`) |

---

## 10. Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `pinpoint` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `JWT_SECRET` | `dev-secret-change-in-production` | JWT signing secret. In `NODE_ENV=production`, the server's `validateConfig()` exits with code 1 if this is unset, empty, or one of the well-known dev placeholders (`dev-secret`, `dev-secret-change-in-production`, `change-me`) — see Requirement 21. |
| `PORT` | `3001` | API server port |
| `CORS_ORIGIN` | `http://localhost:4173` | Allowed CORS origin (dashboard origin in Compose). Set explicitly in production. |
| `APP_URL` | `http://localhost:4173` | Base URL embedded in outgoing emails (verification, password reset). |
| `NODE_ENV` | `development` | Environment (`development` / `test` / `production`). |

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
  React, no `@vitejs/plugin-react`. The build is currently `tsc --build`
  while Phase 14 (CRXJS) is in flight; once that lands the script becomes
  `vite build`.

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

Sliding-window refresh (`POST /api/v1/auth/refresh`, 7-day post-`exp` grace)
and the in-extension popup login surface land in Phase 15.

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
→ Make sure Developer mode is enabled. The extension requires bundled JS files in `dist/` — run `npm run build --workspace extension` first. Once Phase 14's CRXJS toolchain lands, the bundle will be Web-Store-loadable as-is.

**WebSocket connection fails**
→ The Socket.IO server runs on the same port as the API (3001). Ensure CORS is configured to allow your dashboard origin.
