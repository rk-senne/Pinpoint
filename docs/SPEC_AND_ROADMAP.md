# Pinpoint — SaaS Pivot Spec & Roadmap

**Date:** 22 May 2026 | **Status:** Approved for Development

---

## Vision

**From:** Chrome extension feedback tool (single user)  
**To:** Collaborative website feedback SaaS platform (multi-tenant, teams, billing)

**Tagline:** "Point. Comment. Resolve."

---

## Figma/Design Reference

The dashboard will be rebuilt with a proper design system. Extension UI remains Web Components in Shadow DOM.

---

## Roadmap

```
Month 1-6              Month 7-14           Month 15-24          Month 25-36
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  PHASE 1     │────▶│  PHASE 2     │────▶│  PHASE 3     │────▶│  PHASE 4     │
│  Foundation  │     │  Growth      │     │  Scale       │     │  Platform    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

---

## Phase 1: Foundation (14 weeks to GA)

| Week | Milestone |
|------|-----------|
| 1-3 | Multi-tenancy (org model, RLS, data migration) |
| 4-5 | Auth & Teams (RBAC, invitations, org switching) |
| 6-7 | Billing (Stripe subscriptions, plan enforcement) |
| 8-10 | Integrations (Slack, Jira) + Notifications |
| 11-12 | Public API v1 + Security hardening |
| 13-14 | Infrastructure (staging/prod) + GA launch |

**Exit:** 50 paying customers, <2% involuntary churn.

---

## Phase 2: Growth

Integrations (Linear, GitHub, Asana), workflows, client portal, video recording, reporting, mobile responsive.

**Exit:** 500 paying customers, NPS >40.

---

## Phase 3: Scale

Public API, white-label, enterprise (SSO, SCIM, audit logs), SDK, SOC 2.

**Exit:** 5 enterprise contracts >$1K/mo.

---

## Phase 4: Platform

Marketplace, AI features, advanced analytics, partner program, embedded widget.

**Exit:** $3M+ ARR.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 + TypeScript |
| Database | PostgreSQL (RLS for multi-tenancy) |
| Real-time | Socket.IO (Redis adapter) |
| Auth | JWT + OAuth 2.0 |
| Billing | Stripe |
| Storage | S3 + CloudFront |
| Extension | Chrome MV3, Web Components |
| Dashboard | Vanilla TS (signals + templates) |
| Infra | Docker → ECS Fargate + Terraform |
| CI/CD | GitHub Actions |

---

## Key Documents

| Document | Path |
|----------|------|
| Business Analysis | `docs/BUSINESS_ANALYSIS.md` |
| Technical Roadmap | `docs/TECHNICAL_ROADMAP.md` |
| Product Strategy | `docs/PRODUCT_STRATEGY.md` |
| Spec & Roadmap | `docs/SPEC_AND_ROADMAP.md` (this file) |
| Changelog | `CHANGELOG.md` |

---

## Immediate Next Steps

1. ⬜ Initialize git repo
2. ⬜ Set up multi-tenancy (organizations table, RLS policies)
3. ⬜ Extend JWT with org_id + role
4. ⬜ Build invitation flow
5. ⬜ Integrate Stripe (subscriptions + webhooks)
6. ⬜ Deploy staging environment
