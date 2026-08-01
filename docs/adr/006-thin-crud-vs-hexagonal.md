# ADR-006: Thin CRUD Routes vs Hexagonal Domain Layer

## Status

Accepted

## Context

Mission E1 asked us to decide for each non-hexagonal route whether to extract it into a full domain use case or document it as "thin CRUD."

The following route files operate directly on Knex without domain use cases:

- `premium.routes.ts` — Boards (CRUD), CSAT scoring, Approval workflows
- `workflow.routes.ts` — Automation rules, SLA policies
- `clientPortal.routes.ts` — Portal CRUD
- `heatmap.routes.ts` — Read-only aggregation query
- `integrations.routes.ts` — Third-party integration CRUD
- `reporting.routes.ts` — Read-only analytics queries
- `feedback.routes.ts` — Public feedback ingestion

## Decision

**Keep as thin CRUD.** These routes do not warrant a full hexagonal extraction because:

1. **No complex business logic** — they are straightforward database operations (insert/select/update/delete) with Zod validation at the boundary.
2. **No cross-cutting domain rules** — unlike auth (which has password policy, rate limiting, email verification) or annotations (which have pin numbering, event broadcasting, screenshot handling), these features have no invariants that span multiple aggregates.
3. **Low change frequency** — these premium features are stable and unlikely to need alternative adapters (no one will swap Knex for a different ORM in these routes specifically).
4. **Validation is already at the boundary** — Zod schemas enforce all input constraints before the database call.

**Already hexagonal:** `billing.routes.ts` uses `CreateCheckoutSession`, `HandleStripeWebhook`, `GetBillingPortal`, `GetUsageSummary` use cases because billing has complex invariants (plan limits, subscription state machines, webhook signature verification).

## Consequences

- New features with complex invariants (multi-step flows, cross-aggregate consistency, side effects) MUST go through the domain layer.
- Simple CRUD for premium features MAY remain as direct Knex routes with Zod validation.
- The ESLint hexagonal boundary rule (`no-restricted-imports`) is NOT enforced on files in the `premium/` or thin-CRUD routes — only on the core domain routes (auth, projects, annotations, comments, teams, guidelines, shared-links, notifications).
