# Pinpoint — Technical Roadmap

**Version:** 1.0 | **Date:** 22 May 2026 | **Status:** Draft

---

## Current Stack Assessment

**Keep:** Express 5, PostgreSQL, Knex, Socket.IO, Chrome Extension (MV3), Vanilla TS Dashboard, S3, JWT, Docker Compose.

**Change:** Add multi-tenancy (RLS), billing (Stripe), RBAC, integrations (OAuth), notifications, public API, infrastructure (ECS/Fargate).

---

## Multi-Tenancy: Shared DB + Row-Level Security

- `org_id` column on all tenant tables
- PostgreSQL RLS policies enforce isolation at DB level
- Knex transaction wrapper sets `SET LOCAL app.current_org_id` per request
- JWT extended with `org_id` + `role` claims

---

## Billing (Stripe)

- Stripe Subscriptions for plan management
- Usage metering (annotations/month) via cron job
- Webhook handlers for payment events
- Middleware enforces plan limits (soft warn at 80%, block at 100%)
- Stripe Customer Portal for self-service billing management

---

## Team & Permissions (RBAC)

Roles: `owner > admin > member > viewer`

- Invite flow: email → signed token → accept → membership created
- Permission middleware: `requireRole('owner', 'admin')` per route
- Org switching for users in multiple organizations

---

## Integrations (OAuth + Webhooks)

| Provider | Auth | Actions |
|----------|------|---------|
| Slack | OAuth 2.0 | Post feedback to channel |
| Jira | OAuth 2.0 (3LO) | Create/sync issues |
| Linear | OAuth 2.0 | Create issues, sync status |
| GitHub | GitHub App | Create issues, link PRs |

Token refresh handled automatically. Webhook signatures verified per provider.

---

## Notification System

Channels: in-app (Socket.IO), email (AWS SES), browser push (Web Push API).
Per-user preferences. Event-driven delivery. Email digests (daily/weekly).

---

## Public API (v1)

- REST, versioned (`/api/v1/`), API-key authenticated
- Rate limited per plan tier (60-1000 req/min)
- Paginated responses with `meta.total`, `meta.has_more`
- Webhook registration for event subscriptions

---

## Infrastructure Target

```
CloudFront CDN → ALB → ECS Fargate (API + Workers) → RDS + Redis + S3 + SQS
```

- Staging + Production environments
- CI/CD: GitHub Actions → ECR → ECS (blue-green)
- Terraform for all AWS resources

---

## Migration Plan (Zero Downtime, 14 weeks)

| Week | Milestone |
|------|-----------|
| 1-3 | Multi-tenancy (org model, RLS, backfill) |
| 4-5 | Auth & Teams (RBAC, invitations) |
| 6-7 | Billing (Stripe integration) |
| 8-10 | Integrations & Notifications |
| 11-12 | Public API & Security hardening |
| 13-14 | Infrastructure & GA launch |

All migrations are backward-compatible (expand-contract pattern). Feature flags gate new functionality.

---

## Security

- Helmet.js (done), CSRF (double-submit cookie), per-tenant rate limiting
- RLS for data isolation, S3 keys prefixed by org_id
- Encrypted tokens at rest, audit log for sensitive actions
- Dependency scanning in CI, quarterly pen tests (Phase 3+)

---

## Testing

- Unit (Vitest, >80% coverage on services)
- Integration (Testcontainers + PostgreSQL, RLS enforcement)
- Contract (Pact: Extension ↔ API, Dashboard ↔ API)
- E2E (Playwright: signup, annotate, assign, billing)
- Load (k6: p95 <200ms at 500 concurrent users)
