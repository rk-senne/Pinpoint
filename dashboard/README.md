# `@pinpoint/dashboard`

The Pinpoint Web Dashboard — vanilla TypeScript, Vite, no React.

This package replaces the prior React + react-router-dom implementation with
a small post-React stack:

- HTML `<template>` blocks declared in `index.html` are cloned into the
  route root by each page module under `src/pages/` via the helpers in
  `src/lib/render.ts` (`cloneTemplate`, `bind`, `delegate`).
- A 30-line reactive primitive — `signal<T>()` from `@pinpoint/shared`
  — drives DOM updates. Each surface owns one or more stores under
  `src/stores/`.
- Routing is the History API behind a ~50-LOC router in `src/lib/router.ts`
  (`defineRoute`, `navigate`, `useRoute`, `start`).
- CSS Modules ride on top of Vite's defaults; the shared theme
  (`SEVERITY_COLORS`, `STATUS_LABELS`, `themeCss()`) comes from
  `@pinpoint/shared/theme`.

There are no React dependencies — `react`, `react-dom`, `react-router-dom`,
`@types/react`, `@types/react-dom`, and `@vitejs/plugin-react` were removed
from `package.json` as part of the post-React migration (Requirement 31.1).

## Authentication

`POST /api/v1/auth/login` issues two cookies:

- `fl_session` — HttpOnly, Secure, `SameSite=Lax` (the JWT)
- `fl_csrf` — readable, `SameSite=Lax` (the double-submit token)

`src/lib/api.ts` sends every request with `credentials: 'include'`. For
`POST` / `PUT` / `PATCH` / `DELETE` it echoes the in-memory CSRF token
(captured from the login response by `src/lib/auth.ts`) as `X-CSRF-Token`.
The dashboard never writes auth state to `localStorage`.

`API_BASE = '/api/v1'` is the single source of truth for the API path
prefix.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server on port 5173. `/api` is proxied to `http://localhost:3001`. |
| `npm run build` | `tsc --noEmit && vite build`. Outputs the production bundle to `dist/`. |
| `npm run preview` | Serve the production build from `dist/` (port 4173 in Compose). |
| `npm test` | Run the Vitest suite for the dashboard package. |

Run from the repo root with `npm run <script> --workspace dashboard` if you
prefer.

## Where things live

```
src/
├── components/         # AppLayout, ProjectListSidebar, TeamManagement
├── lib/
│   ├── api.ts          # API_BASE='/api/v1', credentials:'include', CSRF
│   ├── auth.ts         # in-memory CSRF + bearer; getIsAuthed/probeIsAuthed
│   ├── render.ts       # cloneTemplate, bind, delegate
│   ├── router.ts       # defineRoute, navigate, useRoute, start
│   ├── socket.ts       # Socket.IO handshake (uses the in-memory bearer)
│   └── stores.ts       # legacy signal-store entry; new stores under stores/
├── pages/              # AuthPage, DashboardHome, ProjectView, SettingsPage,
│                       # SharedProjectView, VerifyEmailPage
└── main.ts             # entry point — defines routes, kicks off the router
```

Templates for every page are inlined in `index.html` so the bundler can
ship them as static markup.
