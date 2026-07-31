# Contributing to Pinpoint

Thank you for contributing to Pinpoint! This guide covers the conventions,
workflow, and architecture rules that keep the codebase coherent.

---

## Getting Started

### Prerequisites

- **Docker** 24+ (Docker Desktop on macOS/Windows, or the engine on Linux)
- **Docker Compose** v2 (bundled with modern Docker Desktop)
- **Node.js** 20+ and **npm** 9+ (for host-side lint, typecheck, and extension build)
- **PostgreSQL** 14+ (only if running outside Docker)

### Setup

```bash
git clone <repo-url> && cd pinpoint
npm install              # install all workspace dependencies
docker compose up        # start Postgres, run migrations, boot API + Dashboard
```

When the stack is healthy:

- Dashboard → http://localhost:4173
- API → http://localhost:3001 (health at http://localhost:3001/health)

### Useful Commands

```bash
npm run build            # build every workspace (shared → server → dashboard → extension)
npm test                 # vitest suite (unit + property-based + integration)
npm run typecheck        # tsc --noEmit across the monorepo
npm run lint             # ESLint (includes hexagonal boundary rules)
docker compose down      # stop containers, keep DB volume
docker compose down -v   # stop containers AND wipe DB volume
```

---

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | When to use                                  |
|------------|----------------------------------------------|
| `feat`     | A new feature                                |
| `fix`      | A bug fix                                    |
| `docs`     | Documentation only changes                   |
| `refactor` | Code change that neither fixes nor adds      |
| `test`     | Adding or updating tests                     |
| `chore`    | Tooling, CI, deps, configs                   |

### Examples

```
feat(extension): add offline outbox for annotations
fix(server): prevent duplicate pin numbers under contention
docs: add ADR for hexagonal architecture
refactor(dashboard): extract template helpers into lib/dom.ts
test(shared): add fast-check round-trip for EnvironmentMetadata
chore: bump vitest to 2.1
```

---

## Branching Strategy

| Branch pattern | Purpose                  |
|----------------|--------------------------|
| `main`         | Production-ready code    |
| `feat/*`       | New features             |
| `fix/*`        | Bug fixes                |
| `chore/*`      | Maintenance & tooling    |

All branches are created from `main` and merged back via Pull Request.

---

## PR Process

1. **Branch from `main`** — `git checkout -b feat/my-feature main`
2. **Implement** — make your changes, following the code style below.
3. **Verify locally:**
   ```bash
   npm run typecheck   # tsc --noEmit must pass
   npm test            # vitest must pass
   npm run lint        # eslint must pass
   ```
4. **Push and open a PR** — target `main`. Include:
   - A clear title (conventional-commit style, e.g. `feat(server): add team invites`)
   - A description explaining *what* changed and *why*
   - Reference any related issues
5. **Address review feedback** — push fixup commits, squash on merge.

---

## Code Style

### No React

Both client packages (dashboard, extension) are **React-free**. Do not introduce
React, Preact, Solid, or any virtual-DOM library. The UI layer is:

- **Dashboard** — clone `<template>` blocks from `dashboard/index.html`, bind
  them with `signal<T>()` subscriptions from `@pinpoint/shared`, route with the
  History API (`dashboard/src/lib/router.ts`).
- **Extension** — Web Components (Custom Elements in Shadow DOM) sharing one
  constructable stylesheet from `@pinpoint/shared/theme`.
- **Reactivity** — the ~30-LOC `signal<T>()` primitive in
  `shared/src/signal.ts`. No external state libraries.

### Server: Hexagonal Architecture

```
server/src/
├── domain/         # Pure business logic, types, errors
├── ports/          # Interfaces (inbound + outbound)
├── adapters/       # Implementations (HTTP routes, DB repos, email, etc.)
└── composition/    # Wires domain ↔ ports ↔ adapters at startup
```

- `domain/` **cannot** import from `adapters/`.
- `adapters/` depend on `ports/` interfaces, never on each other.
- Only `composition/` knows about both domain and adapters — it wires the
  dependency graph at startup.

### Extension: Web Components in Shadow DOM

Each UI piece is a Custom Element (`<fl-*>`) attached to a Shadow Root:
`<fl-overlay-host>`, `<fl-popover>`, `<fl-floating-toolbar>`,
`<fl-sidebar-panel>`, `<fl-annotation-pin>`, `<fl-mention-autocomplete>`,
`<fl-comment-thread>`.

All elements adopt the shared constructable stylesheet. Keep component logic
self-contained; communicate via DOM events and shared signals.

### Dashboard: cloneTemplate + signal subscriptions

Pages live under `dashboard/src/pages/`. Each page module:

1. Calls `cloneTemplate('template-id')` to get a DOM fragment.
2. Queries elements within the fragment.
3. Subscribes to signals to reactively update the DOM.
4. Returns the fragment for the router to mount.

---

## Testing

| Layer           | Tool                     | Location                           |
|-----------------|--------------------------|------------------------------------|
| Unit            | Vitest                   | `*.test.ts` co-located with source |
| Property-based  | Vitest + fast-check      | Serialization round-trips, invariants |
| Integration     | Vitest                   | Socket.IO flows, DB queries        |
| End-to-end      | Playwright               | `e2e/` workspace                   |

### Guidelines

- Every new feature needs at least unit tests.
- Serialization code (Zod schemas, environment metadata) should have
  **fast-check property tests** proving round-trip fidelity.
- Integration tests that need Postgres use the Compose `db` service.
- Run `npm test` before pushing — CI will reject failing suites.

---

## Architecture Rules

These rules are enforced by ESLint boundary rules and are non-negotiable:

1. **`domain/` cannot import `adapters/`** — domain logic must remain pure and
   infrastructure-agnostic.
2. **Only `composition/` wires both** — it is the only layer that imports from
   both `domain/` and `adapters/`.
3. **Shared types go in `@pinpoint/shared`** — never duplicate types between
   workspaces.
4. **No `localStorage` for auth in the Dashboard** — cookies only (HttpOnly
   `fl_session` + readable `fl_csrf`).
5. **Extension uses Bearer JWT** — stored in `chrome.storage.local`, sent as
   `Authorization: Bearer <token>`.

---

## Need Help?

- Check `docs/ENHANCEMENTS.md` for the current work plan.
- Read the ADRs in `docs/adr/` for architectural context.
- Open a Draft PR early if you want feedback before finishing.
