# ADR-002: Hexagonal Architecture for the Server

## Status

Accepted

## Date

2025-05-24

## Context

The Pinpoint API server started as a typical Express app with route handlers
directly calling Knex queries and sending emails. As the feature set grew
(teams, notifications, shared links, analytics, billing), this structure led to:

- **Fat route handlers** — business logic mixed with HTTP parsing and DB access,
  making unit testing require full integration setups.
- **Hidden coupling** — a change to the email provider required touching route
  files that had nothing to do with email.
- **Difficult testing** — mocking Knex at the module level was fragile and
  broke when internal query structure changed.

The team needed an architecture that:

1. Keeps domain logic pure and testable without infrastructure.
2. Makes infrastructure swappable (e.g., switching from Knex to Prisma, or
   swapping email providers) without touching business rules.
3. Provides clear boundaries enforceable by linting.

## Decision

Adopt hexagonal architecture (ports & adapters) for the server:

```
server/src/
├── domain/         # Pure business logic, domain types, domain errors
│                   # No imports from adapters/ or external I/O libraries
├── ports/          # Interfaces defining what the domain needs
│   ├── inbound/    # Use-case interfaces (called by adapters)
│   └── outbound/   # Repository & service interfaces (implemented by adapters)
├── adapters/       # Infrastructure implementations
│   ├── inbound/    # HTTP routes, WebSocket handlers, workers
│   └── outbound/   # PostgreSQL repos, email service, file storage
└── composition/    # Application bootstrap — wires domain, ports, and adapters
```

### Rules

- `domain/` **must not** import from `adapters/` or any I/O library (knex, nodemailer, etc.).
- `adapters/` depend on `ports/` interfaces, never on concrete implementations
  of other adapters.
- `composition/` is the only module that imports from both `domain/` and
  `adapters/` — it constructs the dependency graph and hands it to the HTTP
  server.
- ESLint boundary rules (`eslint-plugin-boundaries`) enforce these import
  restrictions in CI.

## Consequences

### Positive

- **Testable domain** — domain services can be unit-tested with in-memory
  fakes; no database required.
- **Swappable infrastructure** — replacing the email adapter or adding a
  cache layer requires implementing a port interface, not rewriting domain code.
- **Clear ownership** — each layer has a single responsibility; code reviews
  catch boundary violations early.
- **Enforced by tooling** — ESLint boundary rules make violations a CI failure,
  not just a convention.

### Negative

- **More files and indirection** — simple features require touching domain,
  port, adapter, and composition layers.
- **Learning curve** — contributors unfamiliar with hexagonal architecture need
  onboarding.
- **Over-engineering risk for small features** — trivial CRUD may feel
  ceremonious, but consistency outweighs per-feature optimization.
