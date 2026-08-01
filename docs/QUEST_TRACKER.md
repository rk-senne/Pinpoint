# Pinpoint — Quest Tracker

Check off each quest as you complete it. Each phase builds on the last.

---

## Phase 0 — Cleanup & Prep (✅ mostly done)

- [x] Add .gitignore
- [x] Add .env.example, remove committed .env
- [x] Add helmet.js security headers
- [x] Add test coverage enforcement
- [x] Add Prettier config
- [x] Deep health check (DB connectivity)
- [x] Enhanced DB pool config
- [x] CHANGELOG.md
- [x] Initialize git repo
- [x] Remove committed dist/ folders from tracking
- [x] Add LICENSE file
- [x] Add stricter rate limit on auth endpoints (5/min)

💡 *Tip: `git init && git add . && git commit -m "feat: initial commit"` — history starts now.*

---

## Phase 1 — Multi-Tenancy (Weeks 1-3)

- [x] Create `organizations` table migration
- [x] Create `memberships` table migration (user ↔ org, with role)
- [x] Create `invitations` table migration
- [x] Add `org_id` column to `projects` table
- [x] Add `org_id` column to `feedback` table
- [x] Add `org_id` column to `comments` table
- [x] Add `org_id` column to `screenshots` table
- [x] Backfill script: create default org, assign existing user as owner
- [x] Enable RLS on all tenant tables
- [x] Create RLS policies (tenant isolation)
- [x] Create `withTenant()` transaction helper
- [x] Add tenant middleware (extract org_id from JWT, set on DB connection)
- [x] Extend JWT claims with `org_id` and `role`
- [x] Update all existing queries to be tenant-aware
- [x] Integration test: verify cross-tenant data isolation

💡 *Tip: Do expand-contract migrations — add columns as nullable, backfill, then add NOT NULL constraint. Never break existing queries.*

---

## Phase 2 — Auth & Teams (Weeks 4-5)

- [x] Add OAuth 2.0 login (Google)
- [x] Add OAuth 2.0 login (GitHub)
- [x] Implement invitation flow (email → token → accept)
- [x] Invitation email template (with branded link)
- [x] Org switching (user can belong to multiple orgs)
- [x] RBAC middleware: `requireRole('owner', 'admin')`
- [x] Permission checks on all existing routes
- [x] Team members list endpoint
- [x] Remove member endpoint
- [x] Change member role endpoint
- [x] Org settings endpoint (name, slug)
- [x] Session revocation (logout from all devices)

💡 *Tip: Deploy RBAC in shadow mode first — log denials but don't block. Flip to enforcing after a week of clean logs.*

---

## Phase 3 — Billing (Weeks 6-7)

- [ ] Create Stripe account + configure products/prices
- [x] `stripe_customer_id` on organizations table
- [x] Create Stripe customer on org creation
- [x] Checkout session endpoint (subscribe to plan)
- [x] Stripe webhook handler (subscription events)
- [x] Plan limits enforcement middleware
- [x] Usage metering (annotations/month count)
- [x] Billing portal redirect endpoint (Stripe Customer Portal)
- [x] Upgrade/downgrade flow
- [x] Grace period on payment failure (3 days)
- [x] Invoice history endpoint
- [x] Free tier limits: 2 seats, 50 annotations/mo, 2 projects

💡 *Tip: Use Stripe Test Mode + CLI (`stripe listen --forward-to`) for local webhook testing. Never test with real cards.*

---

## Phase 4 — Integrations (Weeks 8-10)

- [x] `integrations` table (org_id, provider, tokens, config)
- [ ] OAuth flow: Slack (post feedback to channel)
- [ ] OAuth flow: Jira (create issues from feedback)
- [ ] OAuth flow: Linear (create issues, sync status)
- [ ] OAuth flow: GitHub (create issues, link PRs)
- [x] Token refresh logic (auto-refresh before expiry)
- [x] Webhook signature verification per provider
- [x] Integration settings UI in dashboard
- [x] Notification system: `notifications` table
- [x] In-app notifications (Socket.IO push)
- [x] Email notifications (AWS SES or Resend)
- [x] Notification preferences per user
- [x] @mention detection in comments → trigger notification
- [x] Email digest (daily summary of activity)

💡 *Tip: Build Slack first — it's the simplest OAuth flow and gives immediate visible value to teams.*

---

## Phase 5 — Public API & Hardening (Weeks 11-12)

- [x] `api_keys` table (org-scoped, hashed, with scopes)
- [x] API key creation/revocation endpoints
- [x] API key auth middleware (Bearer token)
- [x] Public API: GET /api/v1/feedback (paginated, filterable)
- [x] Public API: POST /api/v1/feedback
- [x] Public API: PATCH /api/v1/feedback/:id
- [x] Public API: DELETE /api/v1/feedback/:id
- [x] Public API: webhooks registration
- [x] Per-tenant rate limiting (Redis-backed)
- [x] API documentation (auto-generated from Zod schemas)
- [x] CSRF protection (double-submit cookie)
- [ ] Security audit (OWASP ZAP scan)
- [x] Audit log table (sensitive actions)
- [x] Load test with k6 (target: p95 <200ms at 500 concurrent)

💡 *Tip: Auto-generate API docs from your Zod schemas — they're already the source of truth for validation.*

---

## Phase 6 — Infrastructure & Launch (Weeks 13-14)

- [x] Terraform: VPC + subnets
- [x] Terraform: RDS PostgreSQL (Multi-AZ)
- [x] Terraform: ElastiCache Redis
- [x] Terraform: ECS Fargate service (API)
- [x] Terraform: ALB + target groups
- [x] Terraform: S3 + CloudFront (screenshots)
- [x] CI/CD: GitHub Actions → ECR → ECS deploy
- [ ] Staging environment deployed
- [ ] Production environment deployed
- [ ] Custom domain + SSL
- [x] Monitoring: CloudWatch + alerts
- [x] Error tracking: Sentry
- [x] E2E smoke tests on staging
- [ ] 🚀 **GA Launch**

💡 *Tip: Deploy staging first and run it for a week before touching production. Real infra reveals real problems.*

---

## Phase 7 — Growth Features (Post-Launch)

- [x] Dashboard redesign (project cards, feedback list, detail view)
- [x] Kanban board view
- [x] Client portal (branded, guest access)
- [ ] Video/screen recording
- [x] Workflow automation (auto-assign rules, SLA tracking)
- [x] Reporting widgets (resolution time, volume, team activity)
- [x] Mobile responsive dashboard
- [x] Extension: offline queue (IndexedDB)
- [x] Extension: keyboard shortcut capture
- [x] Onboarding wizard (guided first annotation)

💡 *Tip: Ship the dashboard redesign as the first post-launch priority. It's what paying users see every day.*

---

## Progress

Total quests: 100  
Completed: count your [x] marks above  
XP: 5 per quest | Level up every 50 XP

---

*One quest = one PR. Small, focused, shippable.*
