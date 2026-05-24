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
- [ ] Initialize git repo
- [ ] Remove committed dist/ folders from tracking
- [ ] Add LICENSE file
- [ ] Add stricter rate limit on auth endpoints (5/min)

💡 *Tip: `git init && git add . && git commit -m "feat: initial commit"` — history starts now.*

---

## Phase 1 — Multi-Tenancy (Weeks 1-3)

- [ ] Create `organizations` table migration
- [ ] Create `memberships` table migration (user ↔ org, with role)
- [ ] Create `invitations` table migration
- [ ] Add `org_id` column to `projects` table
- [ ] Add `org_id` column to `feedback` table
- [ ] Add `org_id` column to `comments` table
- [ ] Add `org_id` column to `screenshots` table
- [ ] Backfill script: create default org, assign existing user as owner
- [ ] Enable RLS on all tenant tables
- [ ] Create RLS policies (tenant isolation)
- [ ] Create `withTenant()` transaction helper
- [ ] Add tenant middleware (extract org_id from JWT, set on DB connection)
- [ ] Extend JWT claims with `org_id` and `role`
- [ ] Update all existing queries to be tenant-aware
- [ ] Integration test: verify cross-tenant data isolation

💡 *Tip: Do expand-contract migrations — add columns as nullable, backfill, then add NOT NULL constraint. Never break existing queries.*

---

## Phase 2 — Auth & Teams (Weeks 4-5)

- [ ] Add OAuth 2.0 login (Google)
- [ ] Add OAuth 2.0 login (GitHub)
- [ ] Implement invitation flow (email → token → accept)
- [ ] Invitation email template (with branded link)
- [ ] Org switching (user can belong to multiple orgs)
- [ ] RBAC middleware: `requireRole('owner', 'admin')`
- [ ] Permission checks on all existing routes
- [ ] Team members list endpoint
- [ ] Remove member endpoint
- [ ] Change member role endpoint
- [ ] Org settings endpoint (name, slug)
- [ ] Session revocation (logout from all devices)

💡 *Tip: Deploy RBAC in shadow mode first — log denials but don't block. Flip to enforcing after a week of clean logs.*

---

## Phase 3 — Billing (Weeks 6-7)

- [ ] Create Stripe account + configure products/prices
- [ ] `stripe_customer_id` on organizations table
- [ ] Create Stripe customer on org creation
- [ ] Checkout session endpoint (subscribe to plan)
- [ ] Stripe webhook handler (subscription events)
- [ ] Plan limits enforcement middleware
- [ ] Usage metering (annotations/month count)
- [ ] Billing portal redirect endpoint (Stripe Customer Portal)
- [ ] Upgrade/downgrade flow
- [ ] Grace period on payment failure (3 days)
- [ ] Invoice history endpoint
- [ ] Free tier limits: 2 seats, 50 annotations/mo, 2 projects

💡 *Tip: Use Stripe Test Mode + CLI (`stripe listen --forward-to`) for local webhook testing. Never test with real cards.*

---

## Phase 4 — Integrations (Weeks 8-10)

- [ ] `integrations` table (org_id, provider, tokens, config)
- [ ] OAuth flow: Slack (post feedback to channel)
- [ ] OAuth flow: Jira (create issues from feedback)
- [ ] OAuth flow: Linear (create issues, sync status)
- [ ] OAuth flow: GitHub (create issues, link PRs)
- [ ] Token refresh logic (auto-refresh before expiry)
- [ ] Webhook signature verification per provider
- [ ] Integration settings UI in dashboard
- [ ] Notification system: `notifications` table
- [ ] In-app notifications (Socket.IO push)
- [ ] Email notifications (AWS SES or Resend)
- [ ] Notification preferences per user
- [ ] @mention detection in comments → trigger notification
- [ ] Email digest (daily summary of activity)

💡 *Tip: Build Slack first — it's the simplest OAuth flow and gives immediate visible value to teams.*

---

## Phase 5 — Public API & Hardening (Weeks 11-12)

- [ ] `api_keys` table (org-scoped, hashed, with scopes)
- [ ] API key creation/revocation endpoints
- [ ] API key auth middleware (Bearer token)
- [ ] Public API: GET /api/v1/feedback (paginated, filterable)
- [ ] Public API: POST /api/v1/feedback
- [ ] Public API: PATCH /api/v1/feedback/:id
- [ ] Public API: DELETE /api/v1/feedback/:id
- [ ] Public API: webhooks registration
- [ ] Per-tenant rate limiting (Redis-backed)
- [ ] API documentation (auto-generated from Zod schemas)
- [ ] CSRF protection (double-submit cookie)
- [ ] Security audit (OWASP ZAP scan)
- [ ] Audit log table (sensitive actions)
- [ ] Load test with k6 (target: p95 <200ms at 500 concurrent)

💡 *Tip: Auto-generate API docs from your Zod schemas — they're already the source of truth for validation.*

---

## Phase 6 — Infrastructure & Launch (Weeks 13-14)

- [ ] Terraform: VPC + subnets
- [ ] Terraform: RDS PostgreSQL (Multi-AZ)
- [ ] Terraform: ElastiCache Redis
- [ ] Terraform: ECS Fargate service (API)
- [ ] Terraform: ALB + target groups
- [ ] Terraform: S3 + CloudFront (screenshots)
- [ ] CI/CD: GitHub Actions → ECR → ECS deploy
- [ ] Staging environment deployed
- [ ] Production environment deployed
- [ ] Custom domain + SSL
- [ ] Monitoring: CloudWatch + alerts
- [ ] Error tracking: Sentry
- [ ] E2E smoke tests on staging
- [ ] 🚀 **GA Launch**

💡 *Tip: Deploy staging first and run it for a week before touching production. Real infra reveals real problems.*

---

## Phase 7 — Growth Features (Post-Launch)

- [ ] Dashboard redesign (project cards, feedback list, detail view)
- [ ] Kanban board view
- [ ] Client portal (branded, guest access)
- [ ] Video/screen recording
- [ ] Workflow automation (auto-assign rules, SLA tracking)
- [ ] Reporting widgets (resolution time, volume, team activity)
- [ ] Mobile responsive dashboard
- [ ] Extension: offline queue (IndexedDB)
- [ ] Extension: keyboard shortcut capture
- [ ] Onboarding wizard (guided first annotation)

💡 *Tip: Ship the dashboard redesign as the first post-launch priority. It's what paying users see every day.*

---

## Progress

Total quests: 100  
Completed: count your [x] marks above  
XP: 5 per quest | Level up every 50 XP

---

*One quest = one PR. Small, focused, shippable.*
