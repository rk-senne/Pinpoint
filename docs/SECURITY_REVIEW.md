# Pinpoint — Internal Adversarial Security Review

| | |
|---|---|
| Date | 2026-11-16 |
| Branch / state reviewed | `feat/enhancement-roadmap`, uncommitted working tree (server `dist` as running on `127.0.0.1:3001`, dashboard Vite **dev** server on `:5173`) |
| Type | Internal white-box + live black-box review. **This is not an independent penetration test** and must not be presented as one. |
| Scope | API (`server/`), Socket.IO `/collab`, public surfaces (widget, shared links, review proxy, portals, boards, CSAT), dashboard, Chrome extension, MCP server, DB schema, deployment config / CI. |
| Out of scope / not done | Mobile SDK; real object storage / CDN (not configured in the live stack, so upload/serve paths are code-reviewed only); real OAuth providers (not configured); Stripe; load/DoS testing; `npm audit`/SCA (would send the dependency list to an external registry — run it in CI instead); infrastructure as deployed (deployment config read only); browser-level XSS execution (DOM sinks reviewed in source, not driven in a browser). |

## 1. Result summary

No Critical or High findings. The earlier audit's fixes hold up under live attack (see §5). Most of what remains is
**cross-tenant information exposure through side channels** (realtime broadcasts, team objects that are not org-scoped)
and **function-level authorization gaps for the `viewer` role**.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 8 | PP-01 … PP-08 |
| Low | 14 | PP-09 … PP-22 |
| Informational | 3 | PP-23 … PP-25 |

Highest-priority chain: **PP-01 → PP-03**. Any self-registered user (free signup, no org privileges) passively learns
user ids, e-mail addresses and team ids of *other tenants* from realtime events, then uses a team id to read that
team's roster through project creation.

Severity uses CVSS 3.1-style base scores (rough, internal estimate; AV:N unless stated, PR is the lowest privilege that
suffices). They are triage aids, not formal scores.

> **Remediation status (2026-11-16, same branch):** all 8 Medium findings are fixed with regression tests and were
> re-verified live against the running stack; all 14 Low findings are fixed (PP-15, PP-20, PP-21 and PP-22 in a follow-up pass — see §8);
> of the 3 Informational findings 2 are fixed and 1 is accepted. Everything not fully fixed carries a rationale. See [§8 Remediation status](#8-remediation-status) for the per-finding
> file:line and test names, and [§9 Pending client changes](#9-pending-client-changes) for the extension / widget /
> dashboard diffs that belong to other owners.

## 2. Methodology

1. **Surface enumeration** — every route registered in `server/src/adapters/inbound/http/*.ts` and
   `composition/container.ts` (≈170 handlers), the Socket.IO gateway, the review proxy, widget/guest/portal/board public
   routes, extension `manifest.json`/service-worker message handlers, MCP client.
2. **Live probing** against `http://127.0.0.1:3001` and `http://localhost:5173` using throwaway accounts
   (`*@pentest.example`, verified via `psql`) in two separate orgs (A, B), with A containing an owner, an admin and a
   viewer. All requests were scripted with Node `fetch` / `socket.io-client`.
3. **Cross-org IDOR matrix**: 46 `:id`-style requests (projects, pages, annotations, comments, shared links, webhooks,
   api-keys, portals, workflow rules, SLA, teams, boards, approvals, CSAT, bulk, triage, activity, heatmap, feedback,
   deliveries, org members) replayed as org-B owner, org-A viewer and org-A admin. Results in §5.
4. **Privilege / mass-assignment**: PUT/PATCH/POST bodies carrying `role`, `org_id`, `orgId`, `owner_id`, `ownerId`,
   `verified`, `plan`, `id`, `pin_counter`, `status`; viewer→owner/admin escalation attempts.
5. **Auth/session**: JWT `alg=none`, tampered claims, expiry, token_version revocation after reset/removal, CSRF
   double-submit variants (no header, bad header, cookie + bogus bearer, `text/plain`), CORS origins (`evil`, `null`),
   session fixation, password reset (reuse, weak password, session revocation), login/reset/register enumeration and
   timing, rate-limit behaviour.
6. **SSRF**: review proxy with 17 hostile targets (decimal / octal / hex / short IPv4, IPv6 loopback, IPv4-mapped IPv6,
   `localhost.`, `nip.io`, `localtest.me`, userinfo, metadata hostnames, cloud instance-metadata (IMDS) IPv6); webhook URL registration with 8
   schemes/targets; redirect/DNS-pinning logic reviewed in `services/egressGuard.ts`.
7. **Public-surface abuse**: widget key origin binding, quotas, revocation, widget key as bearer, standard key scope and
   route allow-list, shared-link grant forgery/replay/extension, lockout, guest feedback on password-protected links.
8. **Realtime**: unauthenticated and cross-origin-cookie handshakes, foreign `join`, post-removal subscription, event
   scoping (cross-tenant listener), cursor relay payloads/flood.
9. **Injection / XSS**: source audit of all DOM sinks (`innerHTML`, `.src`, `.href`, `srcdoc`, `postMessage`) in
   dashboard / extension / widget / shared; CSV formula injection and PDF export; SQL-injection fuzz of search/status/
   pagination/heatmap/audit-log filters; e-mail template HTML injection.
10. **Extension / MCP**: manifest permissions, `externally_connectable`, service-worker message handlers, API relay path
    allow-list, auth bridge sender check, sub-frame `postMessage` relay, MCP key handling.
11. **Config / infra** (read only): helmet/CSP, cookies, `/metrics` gating, RLS migration vs. DB role, firewall/network rules,
    database/object-store/Redis encryption, CI workflow permissions.
12. **Cleanup**: all throwaway users, orgs and dependent rows were deleted (`@pentest.example` users: 0 remaining;
    orphans from PP-10 removed by hand). The SMTP sink log (`$stack/mail.log`) still contains the test addresses.

## 3. Findings

Format: **ID — title** · severity (CVSS) · status of evidence (`LIVE` = reproduced against the running stack, `CODE` = from
source, not reproduced).

### Medium

#### PP-01 — Cross-tenant broadcast of invitation / team events to every `/collab` socket
Medium (6.5, `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`) · LIVE

Events emitted without a `room` are sent to the whole `/collab` namespace. `org.invitation_created` and
`team.member_invited` carry no room, so **any authenticated socket in any org receives them**.

Evidence (org-B owner connected, org-A owner invites):
```
B (other tenant) received: [
 ['org.invitation_created','{"orgId":"086438e7-…","email":"pt-leak-victim@pentest.example","role":"admin","invitationId":"0de1e0d2-…"}'],
 ['team.member_invited','{"teamId":"b1eca1c9-…","teamName":"PT Team","invitedUserId":"656eb0ee-…","invitedEmail":"pt-reset-t@pentest.example"}']]
```
Leaks e-mail addresses, user ids, org ids, team ids/names, invited role. The ids feed PP-03, PP-04 and PP-07.

- Where: `server/src/adapters/outbound/socket/SocketIoEventBus.ts:77` (`event.room ? namespace.to(room) : namespace`),
  emitters `domain/org/usecases/inviteToOrg.ts:105`, `domain/team/usecases/inviteMember.ts:94`
  (also `updateMemberRole.ts:97` — `team.member_promoted_to_owner`).
- Fix: make `room` mandatory for socket delivery. Default-deny: in `SocketIoEventBus.emit`, if `event.room` is unset, do
  **not** emit to the namespace (log + drop). Give those events rooms (`user:<invitedUserId>`, `org:<orgId>` joined in
  the gateway after `checkSession`). Add a unit test that every `DomainEvent` type with PII has a room.

#### PP-02 — Removed / demoted members keep receiving live project data until their socket disconnects
Medium (6.0, `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`) · LIVE

Room membership is authorised once at `join` / `annotation:open`; nothing re-checks on emit and nothing disconnects the
socket when the user is removed.

Evidence: member T joined `project:<P>` and `annotation:<A>`; owner removed T (`DELETE /org/members/T` → 204,
T's REST call → 401). Owner then posted a comment and a new annotation:
```
removed user still connected: true received: [ 'comment.created {"comment":{"id":"4c4e8b87-…","annotationId":"120c06f1-…","authorId":…',
  'comment:created {…}', 'annotation.created {"id":"984776e7-…","projectId":"6913661f-…","pageId":…', 'annotation:created {…}' ]
```
Full annotation / comment bodies reach a user whose access was revoked (offboarding scenario).

- Where: `server/src/adapters/inbound/websocket/collab.gateway.ts:217-237` (join), `:282` (annotation:open);
  removal path `adapters/inbound/http/org.routes.ts:103-145` (bumps `token_version`, revokes keys, but not sockets);
  same gap for `teams` member removal and password reset / `revoke-sessions`.
- Fix: on member removal, role change, team removal, project deletion, `revoke-sessions`, reset-password and logout call
  `io.of('/collab').in('user:<id>').disconnectSockets(true)` (the gateway already puts each socket in `user:<id>`);
  additionally re-run `checkSession` + `canAccessProject` every N minutes per socket (or on `token_version` change via
  Redis pub/sub for multi-instance).

#### PP-03 — Cross-tenant team roster disclosure through `POST /projects { teamId }`
Medium (6.0, `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`) · LIVE

`createProject` accepts any team UUID without verifying that the caller belongs to it (or that it belongs to the same
org). `GET /projects/:id` and `/projects/:id/members` then return the team's members (userId, e-mail, name, avatar,
role).

Evidence (org-A admin M, team owned by org-B user):
```
POST /api/v1/projects {"name":"mass3","urls":[…],"teamId":"<org-B team>"} → 201
GET  /api/v1/projects/<new> → 200 "teamMembers":[{"userId":"9fae…","email":"pt-a-admin@…"},{"userId":"8320…","email":"pt-b-owner@pentest.example",…}]
```
Team ids are obtained from PP-01. Also lets a member attach their project to a team they are not in (injecting a
project into other members' lists).

- Where: `server/src/adapters/inbound/http/projects.routes.ts:70` (schema), `:107` (handler),
  `domain/project/usecases/createProject.ts:82-83`.
- Fix: in `createProject`, require `teamMemberRepo.findByTeamAndUser(teamId, owner)` with role owner/admin (and, with
  PP-04, `team.org_id === caller.orgId`); return 404 otherwise.

#### PP-04 — Teams are not tenant-scoped; any user can add any registered user to their team (and enumerate accounts)
Medium (5.4, `AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N`) · LIVE

`teams` has no `org_id`; `POST /teams/:id/invite` adds an existing user by e-mail, immediately and without consent, even
if that user belongs to a different org. 404 vs 201 is a registered-e-mail oracle for any authenticated user. The invitee
then sees the inviter's full team roster via `GET /teams` (org-B user saw A's team members).

Evidence: `invite nobody-here@… → 404 "No user found with that email."`; `invite pt-b-owner@… (other org) → 201`;
`GET /teams` as that user → 200 with A's `members`.

- Where: `server/src/adapters/inbound/http/teams.routes.ts:56` (create), `:115` (invite);
  `domain/team/usecases/inviteMember.ts:77` (lookup by e-mail).
- Fix: add `teams.org_id` (FK, NOT NULL) and require the invitee to be a member of the same org; make team add an
  invitation (pending → accepted) rather than an immediate insert; return a uniform response for unknown e-mails.

#### PP-05 — `viewer` role is only enforced on annotation/comment routes (broken function-level authorization)
Medium (5.3, `AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N`) · LIVE

A `viewer` can: create projects (consuming plan quota), create **public share links** (open or password), **client
portals** and **public feedback boards** (global slugs → slug squatting under the org's brand), teams, guidelines; and
can **list webhook endpoints** (URLs frequently embed secrets, e.g. Slack incoming-webhook URLs) and API-key metadata.
Admin-only routes themselves (`api-keys` create, org settings, workflows, integrations, audit log) correctly return 403.

Evidence (viewer): `POST /projects → 201`, `POST /projects/:id/share → 200`, `POST /portals → 201`,
`POST /boards → 201`, `POST /teams → 201`, `POST /guidelines → 201`, `GET /webhooks → 200`, `GET /api-keys → 200`.

- Where: `projects.routes.ts:107`, `sharedLinks.routes.ts:74`, `clientPortal.routes.ts:72`,
  `premium.routes.ts:76` (boards), `teams.routes.ts:56`, `guidelines.routes.ts:62`, `webhooks.routes.ts:72`,
  `apiKeys.routes.ts:110`.
- Fix: apply `requireWriteAccess` to every mutating route by default (mount it once per router) and
  `requireOrgAdmin` to `GET /webhooks` and `GET /api-keys`; return the webhook URL redacted (`https://host/…`) to
  non-admins. Add a table-driven test that every non-GET route denies `viewer`.

#### PP-06 — E-mail change requires no re-authentication, no re-verification and keeps all sessions
Medium (5.4, `AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N`) · LIVE

`PUT /users/me {email}` changes the login e-mail immediately; `verified` stays `true`, old JWTs stay valid
(`token_version` not bumped), no mail is sent to either address. Consequences: (a) a stolen session can silently pivot the
account to an attacker-controlled address (password reset then completes the takeover); (b) a user can *claim* any
address they do not own, shown as verified, and squat it so the real owner cannot register; (c) invitations are bound to
the *current* e-mail, so claiming an address (plus a leaked token) defeats that binding.

Evidence: `PUT /users/me {"email":"victim-never-registered@pentest.example"}` → 200;
DB: `victim-never-registered@…|verified=t|token_version=0`; old token → 200; login with new e-mail → 200.

- Where: `server/src/adapters/inbound/http/users.routes.ts:104`, `domain/user/usecases/updateProfile.ts:57-68`.
- Fix: require current password (or recent re-auth) for e-mail change; store as `pending_email`, send a verification link
  to the **new** address and a notice to the **old** one; apply only on confirmation; then bump `token_version`.

#### PP-07 — `/metrics` is world-readable behind a reverse proxy when `METRICS_TOKEN` is unset
Medium (5.3, `AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N`) · CODE (live stack is not behind a proxy)

Without a token the gate is `isPrivateAddress(req.socket.remoteAddress)`. Behind a reverse proxy the socket peer is always the
proxy's private IP, so *every* public request passes. The deployment config injects `METRICS_TOKEN`, but the boot preflight did not
require it (README calls it "recommended").

- Where: `server/src/infrastructure/metrics.ts:105`; `server/src/config.ts` (preflight).
- Fix: in the exposed-deployment preflight, fail boot if `METRICS_TOKEN` is empty; or gate on `req.ip` (honours
  `trust proxy`) and additionally block when `X-Forwarded-For` is present. Prefer a separate internal listener port.

#### PP-08 — Row-Level Security was enabled but inert (now enforced) — FIXED
Medium (5.0 — control-gap) · was LIVE (DB role) + CODE · **Status: Fixed**

Originally `20260522000002_enable_rls.ts` enabled RLS keyed on `app.current_org_id`, but nothing set that GUC and the app
connected as a `SUPERUSER`/`BYPASSRLS` role, so isolation was application-layer only. RLS is now a real second line:

- **Role** — the API connects as `pinpoint_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`; DML on all tables + sequences,
  `ALTER DEFAULT PRIVILEGES` for future tables). Migrations run as the schema owner (`DB_MIGRATION_USER` /
  `DB_MIGRATION_PASSWORD`, default `DB_USER`); the role is created/updated idempotently from `DB_APP_PASSWORD`
  (`server/src/migrations/20261125000101_row_level_security.ts:85`). `deploy/docker-compose.prod.yml` (api = `pinpoint_app`,
  migrate = owner), `deploy/install.sh`/`upgrade.sh` generate `DB_APP_PASSWORD`; `docker-compose.yml` and the CI e2e job do
  the same.
- **Context** — `server/src/infrastructure/tenantContext.ts`: an `AsyncLocalStorage` store `{ orgId, system }`. On every
  knex connection acquire (`installTenantContext`, `container.ts:171`) it runs
  `select set_config('app.current_org_id', $1, false), set_config('app.system', $2, false)`; a transaction acquires once
  so it keeps the setting. Each raw connection remembers the last pushed context and re-pushes only when it differs, so a
  pooled connection can never run a query under another tenant's context (verified by the concurrency test). The request
  scope is opened after the body parser from the signed session token's org (`container.ts:332`); API-key auth sets it from
  the verified key (`middleware/apiKeyAuth.ts`); socket handlers bind to the socket user's org (`collab.gateway.ts`).
- **Fail closed** — no scope ⇒ both GUCs empty ⇒ every policy is false (0 rows, inserts rejected).
- **What RLS does and does not protect against.** The tenant settings are session GUCs that the
  `pinpoint_app` role can set itself (verified: `set_config('app.system','on',false)` as `pinpoint_app`
  reveals all rows). RLS therefore stops *application bugs* — a query that forgets its `org_id` filter,
  a wrong join, a missed access check — from crossing tenants, and fails closed (zero rows) when no
  context is set. It does **not** stop an attacker who can already execute arbitrary SQL as the app
  role (SQL injection); that remains covered by parameterised queries everywhere (SQLi fuzzing found
  nothing, §7). Closing that gap would need per-tenant database roles or signed context tokens, which
  is not planned.
- **System context** (`app.system = 'on'`, set only by server code via `runAsSystem` / `systemScope`, never from input):
  background workers (`container.ts:830`), public/pre-tenant routes — `/api/v1/auth/*` (login, register, reset, OAuth),
  `/api/v1/shared/*`, `/api/v1/widget/*`, `/review/*`, public client-portal endpoints, the Stripe webhook, invitation
  accept, org switch — and the API-key lookup by hash (`PgApiKeyRepo.findByHash`). The handlers' own `org_id` predicates still
  apply inside these scopes; RLS is the second line, not the only one.

Policy table (`FOR ALL`, identical `USING` and `WITH CHECK`; predicate `ORG` =
`org_id = nullif(current_setting('app.current_org_id', true), '')::uuid`, `SYS` = `current_setting('app.system', true) = 'on'`):

| Kind | Tables | Predicate |
|---|---|---|
| Direct `org_id` | projects, annotations, comments, api_keys, approval_workflows, audit_logs, automation_rules, client_portals, feedback_boards, integrations, invitations, memberships, notification_preferences, satisfaction_scores, sla_policies, subscription_events, teams, usage_records, user_notifications, webhook_endpoints | `ORG OR SYS` |
| Direct + built-ins | guidelines | `ORG OR SYS`, plus a `SELECT`-only policy for built-in rows (`org_id IS NULL`, Nielsen's heuristics) |
| Child via parent | pages, shared_links, tags, activity_events (→ projects); annotation_external_links, annotation_tags, approval_instances, sla_breaches (→ annotations); board_posts, board_votes (→ feedback_boards); portal_sessions (→ client_portals); team_members (→ teams); webhook_deliveries (→ webhook_endpoints) | `EXISTS (parent row) OR SYS` — the parent's policy applies inside the subquery, so it is transitive |
| Own id | organizations | `id = current org OR SYS` |
| **No RLS (by design)** | users, oauth_accounts, auth_tokens (identity; spans orgs; looked up by secret before a tenant is known), notifications (outbox, no org column), knex_migrations* | app-layer only |

Legacy rows with `org_id IS NULL` (guest/widget annotations and their comments) are back-filled from the project, and
`PgAnnotationRepo` / `PgCommentRepo` now inherit the org on insert so guest rows stay visible to their tenant.
`down()` restores the previous state; the role and its grants are kept.

Limits: `users` and `memberships` joins across orgs are still gated by application checks; routes under `systemScope`
rely on their own org predicates; a superuser owner (the stock Postgres image) bypasses RLS, so the API must never use
the owner credentials — enforced by the compose files, not the code.

- Where: `server/src/infrastructure/tenantContext.ts:78-127`, `server/src/migrations/20261125000101_row_level_security.ts`,
  `server/src/composition/container.ts:171,332,830`.
- Tests: `server/src/__tests__/integration/rls.test.ts` (as `pinpoint_app`: cross-org rows invisible on direct, child and
  organizations policies; foreign `org_id` insert rejected by `WITH CHECK`; cross-org update/delete affects 0 rows; no
  context ⇒ 0 rows; system sees all; a transaction keeps its context; concurrent contexts on a 2-connection pool never
  leak; a recycled connection is reset), `server/src/infrastructure/tenantContext.test.ts`, and the full Playwright suite
  run against the API as `pinpoint_app`.
- Overhead (loopback, `select 1`): 0.073 ms/query with a steady context vs 0.076 ms baseline; worst case (context
  alternating every query on one connection, i.e. one extra `set_config` round trip) 0.137 ms (+0.06 ms).

### Low

#### PP-09 — Mentions and assignee are not validated against the org (cross-tenant notification injection)
Low (4.3) · LIVE

`comments` accept arbitrary `mentions` UUIDs / `@<uuid>` in body; `assigneeId` accepts any string. A cross-org user id
received a notification `"<authorId> mentioned …"` containing 200 chars of attacker text; `assigneeId` set to a foreign
user id (200); non-UUID `assigneeId` → 500. User ids are discoverable through PP-01.
Where: `domain/comment/usecases/createComment.ts:108`, `comments.routes.ts:68`, `annotations.routes.ts:112`
(`assigneeId: z.string()`), `updateAnnotation.ts`.
Fix: `z.string().uuid()`; intersect mentions/assignee with `memberships` of the caller's org (and project access).

#### PP-10 — Org-scoped tables lack an FK to `organizations` → orphaned data after org deletion
Low (3.1) · LIVE

After deleting a test org its `client_portals`, `feedback_boards`, `webhook_endpoints` rows remained (and the portal/board
slugs stayed publicly resolvable; webhook rows kept their signing secret). Tables with `org_id` and no FK:
`approval_workflows, automation_rules, client_portals, feedback_boards, integrations, notification_preferences,
satisfaction_scores, sla_policies, user_notifications, webhook_endpoints`.
Fix: migration adding `FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE` (after cleaning orphans);
add an org-deletion/offboarding job + test.

#### PP-11 — Webhook signing secrets stored in plaintext
Low (3.1) · LIVE (`webhook_endpoints.secret = whsec_P3g32m…`)

Integration tokens are AES-GCM encrypted (`INTEGRATION_ENCRYPTION_KEY`); webhook secrets are not. A DB read (backup,
SQLi, replica) lets an attacker forge deliveries to customers' endpoints.
Where: `domain/webhook/usecases/webhooks.ts:90`, `webhooks.routes.ts`. Fix: store via the same `SecretBox`.

#### PP-12 — Registration accepts malformed e-mails and trivially weak passwords
Low (4.0) · LIVE

`email: "notanemail"` → 201 (unverifiable row + queue entry); `Password1234`, `password123456`, `aaaaaaaaaaaa`,
`Qwerty123456` accepted (only length ≥ 10 and a tiny blocklist; `1234567890` is blocked). Registration also e-mails
arbitrary addresses (≤30/15 min per address — mild e-mail-bombing).
Where: `auth.routes.ts:56` (`RegisterBodySchema`), `domain/auth/usecases/registerUser.ts:105`.
Fix: `z.string().email().max(254)`; password check against a breached-password list (e.g. top-100k/HIBP k-anon) plus
zxcvbn-style score; purge unverified accounts after N days.

#### PP-13 — Missing length bounds → 500s (stack trace in development)
Low (3.1) · LIVE

`name` of 5 000 chars on `PUT /users/me` or register, webhook URL of 3 000 chars, `assigneeId="not-a-uuid"`,
`audit-log?dateFrom=garbage` all produce `500 INTERNAL_ERROR` (Postgres length/type error). With `NODE_ENV=development`
the response includes `details.stack` with SQL; `composition/httpGuards.ts` correctly removes it for production /
exposed deployments, so this is an availability/robustness issue plus a reminder never to run `development` on a shared
host. Fix: Zod `.max()` on every string that maps to a bounded column; validate dates.

#### PP-14 — Password-protected shared link: guest feedback bypasses the password; per-link lockout is a DoS handle
Low (3.7) · LIVE

`POST /shared/:linkId/feedback` only needs the (128-bit) link id: with a password set it returned 201 without any grant.
Separately, three wrong passwords lock the link for **all** visitors for 15 min (per-link counter), so anyone holding the
URL can lock out the legitimate audience.
Where: `guestFeedback.routes.ts:141-160`, `sharedLinks.routes.ts:117` / use case `verifyLinkPassword`.
Fix: require the signed access grant for feedback on password links (same `fl_shared_access` check); make the lockout
per (link, IP) with a separate global ceiling.

#### PP-15 — Session hardening gaps
Low (3.5) · CODE/LIVE

(a) Refresh accepts any token up to 7 days *past expiry* and re-issues a fresh 24 h token → no absolute session lifetime
(an extension token used weekly never expires). (b) `jwt.verify` does not pin `algorithms` (library default excludes
`none`; verified `alg=none` is rejected live). (c) The CSRF double-submit token is random but not bound to the session,
and the `fl_csrf` cookie has no `Secure` / `__Host-` prefix → cookie-tossing from a sibling subdomain defeats it.
(d) `fl_session` has no `Max-Age` (session cookie) while the JWT lives 24 h.
Where: `adapters/outbound/jwt/JwtTokenIssuer.ts:62,70`, `domain/auth/usecases/refreshToken.ts`, `auth.routes.ts:87`.
Fix: add `iat`-based absolute max (e.g. 30 d) and reject refresh beyond it; `{ algorithms: ['HS256'] }`; HMAC the CSRF
token with the session id, use `__Host-` cookie names where Path=/ and Secure are possible.

#### PP-16 — MCP server: indirect prompt injection and cleartext option
Low (4.0) · CODE

Annotation/comment text — including **public, unauthenticated** widget/guest submissions — is returned verbatim to the
LLM agent which also holds `update_feedback_status` and `add_comment` tools (the key allow-list limits blast radius to
those two writes, which is good). `PINPOINT_API_URL` permits `http://` for non-local hosts, sending the bearer key in
clear. Upstream error bodies are included in thrown errors.
Where: `mcp-server/src/client.ts:51` (URL check), tool result shaping in `mcp-server/src/index.ts`.
Fix: wrap tool output in an explicit "untrusted user content" envelope; require `https://` unless host is loopback;
document a read-only key (`feedback:read`) as the default for triage agents; truncate upstream error text.

#### PP-17 — E-mail templates interpolate unescaped values (latent HTML injection)
Low (3.1) · CODE (not reachable today)

`renderTemplate`/`emailLayout` insert `projectName`, `actorName`, `insight`, `pinNumber` raw into HTML. I traced all
current producers (`project_deleted` did not even enqueue an e-mail in the live test); no user-controlled value reaches
these fields today, but the first producer that does gives phishing-grade HTML injection in a trusted-sender mail.
Where: `domain/notification/usecases/dispatchPendingNotifications.ts:120-245`.
Fix: escape every interpolation in `emailLayout` (reuse `escapeHtml` from `invitationEmail.ts`), strip CR/LF from subjects.

#### PP-18 — Screenshot upload validates only the client-declared MIME type; body-size cap contradicts the 10 MB limit
Low (3.1) · CODE (S3 unavailable in the live stack: upload returned 503)

`file.mimetype !== 'image/png'` trusts the multipart header; no magic-byte check, so any bytes can be stored as
`image/png` (served with `Content-Type: image/png`, so not directly script-executing). The global `inputSanitizer`
rejects bodies > 1 MB (`413 Request body exceeds 1MB` observed for a 11 MB and a 50 k-rect payload) so legitimate
screenshots between 1 and 10 MB fail. The shared markup renderer interpolates numeric shape fields unescaped into
`innerHTML`; safe now because the server validates `z.number()`, but the document is re-read from S3 and not
re-validated client-side.
Where: `annotations.routes.ts:415`, `middleware/inputSanitizer.ts:3`, `shared/src/markupRender.ts:48-80`,
`dashboard/src/pages/ProjectView.ts:1536,1546`.
Fix: sniff PNG signature (and let `sharp` decode+re-encode); exempt the multipart screenshot route from the 1 MB JSON cap
(keep multer's); `MarkupDocumentSchema.parse` before rendering or build the SVG with DOM APIs.
Note (functional): `GET /annotations/:id/screenshot` and `/markup`, which `ProjectView.ts:1506,1516` calls, are not
mounted (404).

#### PP-19 — `avatarUrl` accepts any scheme and any host
Low (3.1) · LIVE

`javascript:alert(1)` and `data:text/html,<script>…` were stored; they are rendered only as `<img src>` (inert), but an
attacker-chosen `https://` URL is loaded by every teammate's browser (IP/UA tracking pixel; CSP `img-src https:` permits
it). Where: `users.routes.ts:39`, `updateProfile.ts`; sinks `dashboard/src/pages/ProjectView.ts:1811`,
`extension/src/components/FloatingToolbar.ts:211`. Fix: https-only allow-list (or upload + proxy), max length 1024.

#### PP-20 — Guest/portal/board abuse controls are thin
Low (3.7) · CODE

Public board votes use an unverified e-mail as voter identity (unlimited stuffing with fake addresses; only the global
per-IP limiter applies); board posts and portal magic-link requests share the same limiter. CSAT/portal tokens are hashed
at rest and single purpose (good). Where: `premium.routes.ts:98-140`. Fix: per-board + per-IP quotas, e-mail
verification or captcha for votes.

#### PP-21 — Integrations OAuth callback is a placeholder that stores attacker-chosen text as a token
Low (3.7) · CODE

`GET /integrations/:provider/callback` stores `accessToken: "exchanged_" + code` without any provider exchange; the state
cookie HMAC covers `state.orgId.provider` but has no timestamp (cookie `maxAge` is client-enforced) and `Secure` is set
only when `NODE_ENV=production`. Not exploitable without an org-admin-minted state cookie, but it must not ship.
Where: `integrations.routes.ts:92-111,159`. Fix: implement the real code exchange via `safeFetch`, sign an expiry into
the state, bind it to the user id, always `Secure`.

#### PP-22 — Audit log coverage is narrow
Low (3.0 — control gap) · LIVE (`audit_logs` actions: only `api_key.*`, `webhook.*`, `project.deleted`, `member.*`,
`org.settings_updated`)

Not recorded: login success/failure, password reset, e-mail change (PP-06), share-link / portal / board creation,
integration connect/disconnect, data export, invitation create/accept, org switch, session revocation. Relevant for
incident response and SOC 2 (see `SOC2_READINESS.md`). Where: `adapters/inbound/http/auditLog.routes.ts` (`recordAudit`
callers). Fix: audit all security-relevant mutations; add `ip`, `user_agent`, `request_id`; make the table append-only.

### Informational

- **PP-23 — Dashboard dev server (`:5173`) is not hardened.** `vite` dev serves workspace files through `/@fs/…`
  (`/@fs/…/Pinpoint/package.json` → 200) and sends no CSP/XFO; only `vite preview` (Compose/prod image) applies
  `DASHBOARD_CSP`. Never expose the dev server. Also the production CSP allows `connect-src ws: wss:` (any host) and
  `img-src https:` — tighten to the API origin once the deployment topology is fixed. `dashboard/vite.config.ts:24-35`.
- **PP-24 — Project existence oracle.** `GET /projects/:id` returns 403 for a foreign project but 404 for a random id
  (the annotation/comment/heatmap routes use an indistinguishable 404 per `access.ts`). UUIDs are unguessable so impact is
  nil, but make it consistent. `domain/project/usecases/getProject.ts:9`, `projects.routes.ts:203`.
- **PP-25 — Dead / unmounted code with security-relevant routes.** `tags.routes.ts` (project/annotation tags) is not
  mounted (`GET /projects/:id/tags` → 404), `/annotations/:id/screenshot|markup` GET routes are missing (PP-18). Mount with
  `requireProjectAccess` + `requireWriteAccess` when enabling, or delete.

## 4. Chains worth fixing first

1. **PP-01 + PP-03 + PP-04 + PP-09**: a free account harvests `(email, userId, teamId, orgId)` of other tenants from realtime
   events, reads a foreign team roster, force-adds users into its own team, and spams notifications to arbitrary user ids.
   Fixing PP-01 (rooms) removes the discovery step; PP-03/PP-04 close the pivot.
2. **PP-06 + PP-15**: a stolen session or short-lived XSS can change the e-mail (no re-auth), then reset the password; the
   7-day refresh grace keeps a stolen extension token alive indefinitely.
3. **PP-02**: offboarding is not complete until sockets are cut.

## 5. Verified secure (attempted, did not work)

Tenant isolation (46-request IDOR matrix; every cross-org call returned 403/404, or 204 only for the caller's own org):
- projects (GET/PUT/DELETE/members/analytics/export/share/pages), annotations (GET/PUT/status/DELETE/screenshot),
  comments (list/create), activity, heatmap, bulk, triage, feedback (GET/PATCH/DELETE), deliveries/deliver, webhooks
  (PATCH/DELETE/deliveries), API keys (DELETE), portals (create/delete), workflow rules/SLA, approvals/CSAT, boards
  (create), org members (PATCH/DELETE), team invite/role/remove. One observation: `DELETE /workflows/sla/:id` returns 204
  for a foreign id (`workflow.routes.ts:122` does not check the affected-row count). By code the query is
  `where {id, org_id}` so nothing is deleted (not independently confirmed in the DB), but it should return 404.
- Admin cannot: promote to owner, invite an owner, remove an owner, change roles (`403`); viewer cannot: create API keys,
  invite, edit org, read audit log, integrations, mutate annotations/comments/upload screenshots (`403`/`404`).
- Mass assignment: `role`, `verified`, `org_id`, `orgId`, `plan`, `id`, `owner_id`, `pin_counter`, `status` on
  `PUT /users/me`, `POST /projects`, `PATCH /org` were ignored (DB re-read confirmed membership role, org plan, project
  owner/org unchanged).
- Authentication: `alg=none` and tampered-claim JWTs → 401; token_version revocation works after password reset and member
  removal (old token → 401); reset token single-use, hashed at rest, weak new password rejected; login / reset / register
  / resend responses are uniform (no account enumeration; timing for unknown vs wrong password 57 ms vs 59 ms median);
  unverified accounts cannot log in; per-IP, per-(IP,email) and per-email limits return 429.
- CSRF: cookie-authenticated mutations without / with wrong `X-CSRF-Token`, with a bogus bearer, or as `text/plain` →
  403. CORS: `evil.example` and `null` origins never reflected (ACAO fixed to the dashboard origin); widget CORS
  credential-free.
- Shared links: grant cookie bound to link id (replay on another link → 401), expiry extension → 401, password change
  invalidates grants, 3-strike lockout (423) with `Retry-After`, open-link read returns explicit field allow-list only,
  `Cache-Control: no-store`, `X-Robots-Tag: noindex`; 128-bit link ids.
- Review proxy / SSRF: all 16 hostile targets (`127.0.0.1`, `2130706433`, `0x7f.1`, `017700000001`, `127.1`, `[::1]`,
  `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `localhost.`, `0`, `169.254.169.254`, `metadata.google.internal`,
  `[fd00:ec2::254]`, `user@127.0.0.1`, `127.0.0.1.nip.io`, `localtest.me`) → `502 EGRESS_BLOCKED`; webhooks reject
  `http://127.0.0.1`, IMDS, `[::1]`, decimal IP, `file:`, `gopher:`, `ftp:`. Code: byte-level IPv6 classification, DNS
  pinned via undici `lookup`, each redirect hop re-validated, 5 MB streamed cap, `text/html` only. Proxy response carries
  `Content-Security-Policy: … sandbox allow-scripts allow-forms allow-popups` (no `allow-same-origin`), `frame-ancestors`
  allow-list; dashboard parent verifies `event.source` and `event.origin === 'null'`.
- Widget: key bound to one project; disallowed `Origin` (incl. `null`) → 403; daily quota (3 → 4th request 429);
  revoked key → 401; widget key as Bearer → 401; standard key limited by route allow-list + scopes (read-only key
  cannot comment; every non-allow-listed route 401/403); revoked key → 401.
- Realtime: no-auth handshake rejected; cookie handshake from a foreign `Origin` rejected (CSWSH guard); foreign
  `join` → `PROJECT_NOT_FOUND`; `cursor:move` relays only to rooms the sender is in (note: relayed `pageUrl` is not
  type-checked and an object was relayed — clients must treat it as untrusted text; 5 000 cursor events/s were relayed
  without throttling → add a per-socket rate limit).
- Injection: SQL-injection fuzz on `search`, `status`, `pageSize`, `page`, heatmap `pageUrl`, audit-log filters →
  parameterised, no data change (errors only for malformed dates, PP-13). CSV export neutralises `= + - @` leading
  characters with `'`; filename derived from slugified project name. No `innerHTML` with dynamic data in dashboard pages
  (all via `el`/`setText`; `safeText.el` drops unsafe attrs and `javascript:`/`data:` URLs); invitation and portal
  e-mails escape their fields.
- Headers: HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP on the API;
  `fl_session` is `HttpOnly; SameSite=Lax` (+`Secure` unless the local-dev override); stack traces suppressed outside
  non-exposed development; secrets (`api key`, invitation, auth, portal tokens) stored as SHA-256; passwords bcrypt.
- Extension: no `externally_connectable`; background handlers only receive same-extension messages; API relay validates
  method, rejects `..`, `%2e`, `\`, `//`, schemes and control characters and pins the origin; auth-bridge checks
  `sender.id`; sub-frame relay requires a direct child frame and same origin; `window.open` uses `noopener`.
- OAuth: state is HMAC-signed, provider-bound, expiring, single-use cookie; redirects go only to the configured `APP_URL`
  (no open redirect); no `?next=`-style parameter exists in the dashboard router; unverified-provider e-mails cannot link
  or create accounts; unverified local accounts are neutralised on takeover.
- Org invitations: token only e-mailed (hash stored), bound to the invited address, owner-only for owner invites.

## 6. Residual risk / not covered

External pentest, dependency/SCA and container scanning, real-browser XSS execution, object-store/CDN object-level
authorization, Redis-backed multi-instance behaviour (rate limits, Socket.IO adapter, PP-02 pub/sub), Stripe webhook
signature handling, OAuth provider flows, mobile SDK, denial-of-service/load, and the deployed hosting-environment configuration
(deployment config reviewed statically only).

## 7. Machine-readable findings

See the final lines of the agent report (`FINDING|severity|title|file:line|fix`).

## 8. Remediation status

Legend: **Fixed** = code change + regression test; **Accepted** = risk knowingly kept, rationale given; **Deferred** =
not done now, rationale + follow-up given. Test paths are relative to `server/src/` unless noted; the live
re-verification script (19 checks, throwaway `@pp-verify.test` accounts, cleaned up afterwards) reproduced each
Medium against the rebuilt API on `127.0.0.1:3001` — all passed.

### Medium

| ID | Status | Fix (file:line) | Regression tests |
|---|---|---|---|
| PP-01 | **Fixed** | `adapters/outbound/socket/SocketIoEventBus.ts:82` drops room-less events (default-deny). Events now carry rooms: `domain/org/usecases/inviteToOrg.ts:106` (`org:<orgId>`), `domain/team/usecases/inviteMember.ts:107` and `updateMemberRole.ts` (`user:<id>`). The gateway joins `user:<id>` and `org:<orgId>` after `checkSession` (`adapters/inbound/websocket/collab.gateway.ts:212`). | `adapters/outbound/socket/SocketIoEventBus.test.ts` ("drops room-less emits…"), `adapters/outbound/socket/eventRooms.test.ts` (source scan: **every** `eventBus.emit({…})` in `domain/` and `adapters/inbound/` names a room), `adapters/inbound/websocket/collab.gateway.test.ts` ("personal / org rooms"), live: org-B socket received 0 events. |
| PP-02 | **Fixed** | Control event `session.revoked` → `SocketIoEventBus.ts:33,85` (`disconnectSockets(true)` on `user:<id>`). Fired on **every** `token_version` bump via `adapters/outbound/postgres/PgUserRepo.ts:134` (`onSessionRevoked`, wired in `composition/container.ts:220`: logout, password reset, revoke-sessions, org member removal, e-mail change), on org role change (`adapters/inbound/http/org.routes.ts:168`), team member removal (`domain/team/usecases/removeMember.ts:80`) and team demotion (`updateMemberRole.ts:95`). Room joins already re-run `checkSession` + `canAccessProject` (`collab.gateway.ts` join / `annotation:open`). | `domain/team/__tests__/tenantScoping.test.ts` ("PP-02 …"), `SocketIoEventBus.test.ts` ("session.revoked"), `collab.gateway.test.ts` ("re-checks the session on every project join"), `__tests__/integration/securityFindings.test.ts` ("PP-02 session revocation cuts realtime"), live: removed member's socket disconnected, `204`. **Limit:** single-instance emit; with Redis the adapter fans the disconnect out to all instances. |
| PP-03 | **Fixed** | `domain/project/usecases/createProject.ts:56` — `teamId` must be a team of the caller's org that the caller owns/admins, else `NotFound` (404). | `domain/team/__tests__/tenantScoping.test.ts` ("PP-03 createProject validates teamId"), live: foreign `teamId` → 404, own team → 201. |
| PP-04 | **Fixed** | Migration `migrations/20261116000201_teams_org_id.ts` (`teams.org_id` FK, backfilled from the owner's oldest membership, `NOT NULL`; owner-less orphans removed). `domain/team/usecases/inviteMember.ts:34,47,84`: team must belong to the caller's org and the invitee must be a member of it; unknown e-mail and "registered in another org" return the **same** 404. Teams are created with the caller's `orgId` (`teams.routes.ts`). | `tenantScoping.test.ts` ("PP-04 team invites are org-scoped"), `__tests__/integration/authzSecurity.test.ts` (seeds `teams.org_id`), live: identical 404 bodies, B never on A's team. **Not done:** invitation-consent flow (pending → accepted) — same-org users are still added immediately as `viewer`; a consent step is a product change (Deferred). |
| PP-05 | **Fixed** | `adapters/inbound/http/access.ts:238` `guardViewerWrites` wraps the auth middleware of **every** tenant router in `adapters/inbound/http/index.ts:170` (only users/notifications/auth stay self-service). Exemptions are an explicit allow-list (`VIEWER_WRITE_EXEMPT`: org switch, invitation accept, approval decision). `GET /webhooks` (`webhooks.routes.ts:72`) and `GET /api-keys` (`apiKeys.routes.ts:110`) require owner/admin. | `__tests__/integration/viewerWriteGuard.test.ts` — boots the real composition root, enumerates **every mounted mutating route** and asserts `403` for a viewer unless listed in `NOT_VIEWER_GUARDED` (and fails on stale entries), plus the two GET routes; live reviewer repro: all 8 requests `403`. |
| PP-06 | **Fixed** | `domain/user/usecases/updateProfile.ts:37-120`: different e-mail ⇒ `currentPassword` required (wrong ⇒ 403, missing ⇒ 400); stored as `users.pending_email` (migration `20261116000401`), confirmation link (`/verify-email/:token`, kind `change_email`, 1 h) mailed to the **new** address and a notice to the **old** one; a taken address is silently ignored (no account oracle). `domain/auth/usecases/verifyEmail.ts:74` applies it on confirmation, clears `pending_email` and bumps `token_version` (all sessions + sockets revoked). Re-uses the existing dashboard `/verify-email/:token` page. | `domain/user/__tests__/updateProfile.test.ts` ("e-mail change"), `domain/auth/__tests__/confirmEmailChange.test.ts`, live: full flow incl. SMTP sink mails, old JWT → 401 after confirm. Dashboard needs a password field — see §9. |
| PP-07 | **Fixed** | `config.ts:173` — the exposed-deployment preflight exits 1 unless `METRICS_TOKEN` is ≥ 16 chars. `infrastructure/metrics.ts:105` decides by `req.ip` (honours `trust proxy`) and refuses any request with `X-Forwarded-For` / `Forwarded` / `X-Real-IP` when no token is set. README env table + self-hosting tables and `docs/DEPLOYMENT.md` updated. | `config.test.ts` ("METRICS_TOKEN preflight"), `infrastructure/metrics.test.ts` ("tokenless: …"), live: `X-Forwarded-For` ⇒ 403, preflight run against `dist/` refuses without a token. |
| PP-08 | **Fixed** | RLS is enforced: API runs as the unprivileged `pinpoint_app` role (`migrations/20261125000101_row_level_security.ts`), tenant context pushed per connection (`infrastructure/tenantContext.ts`, `composition/container.ts:171,332`), policies on every tenant table, fail-closed, explicit `system` context for workers and pre-tenant routes. See the PP-08 section for the policy table. | `__tests__/integration/rls.test.ts`, `infrastructure/tenantContext.test.ts`, full Playwright suite as `pinpoint_app`. |

### Low

| ID | Status | Fix / rationale | Regression tests |
|---|---|---|---|
| PP-09 | **Fixed** | Assignee: uuid + org-member check (`adapters/inbound/http/annotations.routes.ts:364`, non-UUID is 400 not 500). Comments: `mentions` are `uuid[]` (≤ 50) and intersected with org members (`domain/comment/usecases/createComment.ts:118`, wired with `isOrgMember` in `composition/usecases.ts`). | `__tests__/integration/securityFindings.test.ts` ("PP-09"). |
| PP-10 | **Fixed** | Migration `migrations/20261116000601_org_id_foreign_keys.ts` (orphans deleted, 10 tables get `FOREIGN KEY (org_id) → organizations ON DELETE CASCADE`). Also `client_portals.project_id` / `automation_rules.project_id` → `projects` (`20261116000301`). **Not done:** a scheduled offboarding job — the cascade removes the data on org deletion; there is still no "delete organisation" API (Deferred, product decision). | `__tests__/integration/followups.test.ts` ("PP-10", "deleting a project cascades…"). |
| PP-11 | **Fixed** | `adapters/outbound/postgres/PgWebhookRepo.ts:21,178` encrypts signing secrets with `SecretBox` (same key as integration tokens); migration `20261116000501_encrypt_webhook_secrets.ts` encrypts existing rows (column widened to `text`); legacy plaintext rows stay readable. | `securityFindings.test.ts` ("PP-11"). |
| PP-12 | **Fixed** | `auth.routes.ts:58` e-mail format / length, name ≤ 100; `shared/src/passwordPolicy.ts:62-85` max 128, ≥ 5 distinct characters, blocklist applied to the stem (`Password1234`, `Qwerty123456!`, `P@ssw0rd1234` rejected). **Deferred:** HIBP/zxcvbn and purging unverified accounts (needs a network call / scheduler; the blocklist stem rule covers the reviewer's examples). | `shared/src/passwordPolicy.test.ts` ("PP-12 hardening"), `securityFindings.test.ts` ("PP-12"). |
| PP-13 | **Fixed** | Zod `.max()` on names / URLs / texts across register, login, users, projects, teams, guidelines, comments, annotations, webhooks, portals, workflows, boards; audit-log `dateFrom/dateTo` validated (400). | `securityFindings.test.ts` ("PP-13"), `updateProfile.test.ts`. |
| PP-14 | **Fixed** | Guest feedback on a password link needs the signed grant (`guestFeedback.routes.ts:182`, 401 `SHARED_ACCESS_REQUIRED`). Lockout is per **(link, IP)** (`sharedLinks.routes.ts:76,169`, 3 strikes / 15 min) with a high per-link ceiling (30, `composition/usecases.ts`) as backstop. Limiter is in-memory per instance (a throttle, not authorisation state). | `securityFindings.test.ts` ("PP-14"). |
| PP-15 | **Fixed** (a–d) | (a) absolute session lifetime: `sessionStart` claim carried across refreshes **and org switches** (`org.routes.ts` previously minted a fresh `sessionStart`, silently resetting the 30 d cap), 30 d max (`adapters/outbound/jwt/JwtTokenIssuer.ts`, `domain/auth/usecases/refreshToken.ts`). (b) `algorithms: ['HS256']` pinned for verify + sign. (c) CSRF token is `<nonce>.<HMAC(nonce, userId, sessionStart)>` keyed from the JWT secret (`middleware/sessionCookies.ts` `createCsrfBinder`, enforced in `middleware/csrf.ts`): a cookie-tossed or other-session token fails even though cookie == header. Cookies use the `__Host-` prefix (`__Host-fl_session`, `__Host-fl_csrf`: Secure, `Path=/`, no `Domain`) **only when Secure**; with `COOKIE_INSECURE=true` (local HTTP stack) the legacy names are kept. Every server reader accepts both names; logout clears both generations. (d) `Max-Age=86400` on both cookies (matches the access token; refresh slides it). **Needs a one-line dashboard change on Secure deployments** — see §9 "Dashboard — read the `__Host-fl_csrf` cookie". Sessions created before this deploy hold an unbound CSRF cookie and get `403 CSRF_INVALID` on their next mutation until they log in again (or refresh). | `middleware/sessionCookies.test.ts`, `adapters/outbound/jwt/JwtTokenIssuer.test.ts`, `domain/auth/__tests__/refreshToken.test.ts`, `__tests__/integration/securityHardening.test.ts` ("PP-15"). |
| PP-16 | **Fixed** | `mcp-server/src/client.ts:76` https-only except loopback; upstream error bodies truncated to 300 chars; every tool result is preceded by an explicit "untrusted third-party content" block (`mcp-server/src/server.ts:139`). README: use a `feedback:read` key for triage agents. | `mcp-server/src/client.test.ts`, `mcp.test.ts`. |
| PP-17 | **Fixed** | `domain/notification/usecases/dispatchPendingNotifications.ts:110-260`: every interpolated value HTML-escaped, CR/LF stripped from subjects, CTA URL/label escaped. | same file's test ("renderTemplate escaping"). |
| PP-18 | **Fixed** | `adapters/inbound/http/annotations.routes.ts:91,462` PNG signature required (also for `check-regression`); `middleware/inputSanitizer.ts` allows 12 MB for `POST /annotations/:id/screenshot` only (multer enforces the 10 MB file cap); `GET /annotations/:id/screenshot|markup` added (`annotations.routes.ts:416`, access via `requireAnnotationAccess`). **Deferred:** `sharp` decode/re-encode and client-side `MarkupDocumentSchema.parse` before rendering (`shared/src/markupRender.ts`, owned by the client stages; server validates numbers with zod today). | `middleware/inputSanitizer.test.ts`, `securityFindings.test.ts` ("PP-24 / PP-25"). |
| PP-19 | **Fixed** | `updateProfile.ts` `isAllowedAvatarUrl`: https only, no credentials, ≤ 1024 chars. Clients: see §9. | `updateProfile.test.ts` ("avatar URL"). |
| PP-20 | **Fixed** | Public board writes run behind the shared fail-closed limiter (`middleware/widgetRateLimit.ts`, Redis-backed when `REDIS_URL` is set) with **per-board and per-IP** burst + daily quotas (`premium.routes.ts`, `DEFAULT_BOARD_QUOTAS`): submit 20/h·200/d per board and 5/h·20/d per IP; vote 120/h·2000/d per board and 30/h·200/d per IP; 429 `RATE_LIMITED` + `Retry-After`. Vote dedupe is now per `(post, keyed IP hash)` **in addition to** `(post, e-mail)` (`board_votes.voter_key`, migration `20261118000201_board_vote_dedupe.ts`; the raw IP is never stored): typing a fresh e-mail no longer buys another vote. Limitation: the e-mail on a public vote is still self-declared, not verified — real verification would need a mail round-trip per voter; IP-hash dedupe is the compensating control, so several legitimate voters behind one NAT share one vote per post. Behind a proxy set `TRUST_PROXY` so `req.ip` is the client. | `__tests__/integration/securityHardening.test.ts` ("PP-20"), `authzSecurity.test.ts` (F-12). |
| PP-21 | **Fixed** | Real authorization-code flow (`services/integrations/oauthExchange.ts`): `connect` returns the provider's authorize URL (client id, `redirect_uri=${APP_URL}/api/v1/integrations/:provider/callback`, scopes, state) and the callback exchanges the code at the provider token endpoint through `safeFetch` (https-only, DNS-pinned, no redirects, 10 s timeout, 64 KB cap). A provider is enabled only when `INTEGRATION_<SLACK\|JIRA\|LINEAR\|GITHUB>_CLIENT_ID` **and** `_CLIENT_SECRET` are set (optional `_SCOPES`); otherwise `connect`/callback answer `501 INTEGRATION_NOT_CONFIGURED` — the `exchanged_<code>` placeholder and the `example.com` redirect are gone. Provider failures → `502 OAUTH_EXCHANGE_FAILED` with a generic message (provider body never echoed); consent denial → `400 OAUTH_DENIED`. Tokens are encrypted with `SecretBox` by `PgIntegrationRepo` (`v1.` envelope; verified against the real table). State: signed over `(state, org, provider, uid, exp)`, expiry enforced server-side, bound to the admin and org, `Secure` unless `COOKIE_INSECURE`. Tested against a fake token endpoint only — **no real provider (Slack/Atlassian/Linear/GitHub) was contacted**, so register the redirect URI with each provider and run one real consent before enabling in production. | `adapters/inbound/http/integrations.routes.test.ts` ("PP-21"), `__tests__/integration/securityHardening.test.ts` ("PP-21"). |
| PP-22 | **Fixed** | `audit_logs` is append-only: trigger `audit_logs_no_update_delete` rejects UPDATE/DELETE and `audit_logs_no_truncate` rejects TRUNCATE (migration `20261118000101_audit_log_append_only.ts`); FK actions (org erasure cascade, actor `SET NULL`) are exempt via `pg_trigger_depth() > 1`, so tenant/user deletion still works. New columns `user_agent`, `request_id`; `ip_address` is now populated; `org_id` nullable for tenant-less events. `middleware/auditTrail.ts` records, after the response, successful mutations: `auth.login_succeeded` / `auth.login_failed` (unknown address ⇒ no tenant; e-mail only as hash prefix + domain), `auth.logout`, `auth.password_reset_requested` / `_completed`, `auth.email_change_requested` / `_confirmed`, `auth.email_verified`, `auth.sessions_revoked`, `org.switched`, `export.created`, `share_link.saved`, `portal.created/updated/deleted`, `board.created`, `integration.connected/disconnected`, `webhook.updated`, `invitation.created/accepted`, `team.member_invited/role_changed/member_removed`; the pre-existing `api_key.*`, `webhook.created/deleted`, `member.*`, `org.settings_updated`, `project.deleted` rows now carry ip/UA/request id too. Request/response bodies and secrets are never stored. `GET /org/audit-log` gained `actionPrefix`, `resourceType`, `resourceId`, `ip`, `requestId` filters and returns `ipAddress`, `userAgent`, `requestId`. `X-Request-Id` is now a UUID (pino-http's per-process counter repeated after restarts). Not covered: login attempts rejected by the rate limiter (429) are not written (avoids a DB write per blocked request); board-update/delete, workflow-rule and SLA mutations are not audited; DB superusers can still `ALTER TABLE … DISABLE TRIGGER`, so ship rows to an external store for SOC 2 evidence. | `__tests__/integration/securityHardening.test.ts` ("PP-22"). |

### Informational

| ID | Status | Notes |
|---|---|---|
| PP-23 | **Accepted** | Vite dev server hardening: the dev server must never be exposed (documented). CSP tightening to the API origin is topology-dependent and left to deployment config. |
| PP-24 | **Fixed** | `getProject`, `listProjectMembers`, `exportProjectReport` answer `NotFound` for a project the caller cannot access (`domain/project/usecases/getProject.ts:52,62`); tests updated ("PP-24"). |
| PP-25 | **Fixed** | Dead `tags.routes.ts` (+ its test) **deleted** (unused by any client; its `PUT /annotations/:id/tags` also did not verify that tags belong to the project — reintroduce with that check). `GET /annotations/:id/screenshot|markup` implemented (see PP-18). |

### Server follow-ups from the dashboard stage

| Item | Status | Where |
|---|---|---|
| (a) `PATCH /portals/:id` | **Done** | `adapters/inbound/http/clientPortal.routes.ts` (strict zod, owner/admin, org-scoped, 404, returns `{portal}`); `e2e/browser/portals-workflows.spec.ts` "portal: edit title and toggle active" now runs un-skipped and passes. Tests: `__tests__/integration/followups.test.ts`. |
| (b) duplicate slug → 409 `SLUG_TAKEN` | **Done** | same file (pg `23505`). |
| (c) FK `client_portals.project_id`, `automation_rules.project_id` | **Done** | migration `20261116000301_project_fks_portals_rules.ts`. |
| (d) `DELETE /workflows/sla/:id` → 404 | **Done** | `workflow.routes.ts`. |
| (e) `/portal/:slug` guest page | **Done** | `dashboard/src/pages/PortalGuestPage.ts` (+ template, test). Renders title, welcome, brand colour, logo and the feedback list; the API has no portal submit endpoint, so the page is read-only and says so. |
| (f) SLA breaches panel | **Done** | `dashboard/src/pages/WorkflowsPage.ts` + template, `lib/automationFormat.ts` (`normalizeBreach`). |

## 9. Pending client changes

Files owned by other stages were **not** edited. Apply these exact diffs.

### Dashboard — e-mail change needs the current password (PP-06)

Until this lands, changing the e-mail in Settings shows the server message *"Your current password is required to change
your email."* (name / avatar edits and an unchanged e-mail keep working). In `dashboard/index.html`, after the e-mail
`<label>`:

```diff
+            <label style="display: block; margin-bottom: 12px; font-size: 13px;">
+              Current password <span style="color: var(--pp-text-tertiary);">(only to change your email)</span>
+              <input
+                type="password"
+                autocomplete="current-password"
+                data-role="profile-current-password"
+                style="display: block; width: 100%; padding: 6px 8px; margin-top: 4px; border: 1px solid var(--pp-border-medium); border-radius: 4px; font-size: 13px; box-sizing: border-box;"
+              />
+            </label>
```

In `dashboard/src/pages/SettingsPage.ts`:

```diff
   const profileEmailInput = requireRole(
 ...
+  const profileCurrentPasswordInput = requireRole(profileForm, 'profile-current-password') as HTMLInputElement;
 ...
-      await apiFetch('/users/me', {
+      const res = await apiFetch<{ emailChangePending?: boolean }>('/users/me', {
         method: 'PUT',
         body: JSON.stringify({
           name: profileNameInput.value,
           email: profileEmailInput.value,
+          ...(profileCurrentPasswordInput.value ? { currentPassword: profileCurrentPasswordInput.value } : {}),
           avatarUrl: avatarValue === '' ? undefined : avatarValue,
         }),
       });
-      setProfileMessage('Profile updated.', 'success');
+      profileCurrentPasswordInput.value = '';
+      setProfileMessage(
+        res.emailChangePending
+          ? `Check ${profileEmailInput.value} for a confirmation link; your login email changes once you confirm it (you will be signed out everywhere).`
+          : 'Profile updated.',
+        'success',
+      );
```

(`PUT /users/me` now answers `{ message, user, emailChangePending? }`; `user.email` stays the old address until confirmed.)

### Extension — avatar sink hardening (PP-19, defence in depth)

The server now only stores `https://` avatar URLs; the toolbar should not load anything else and should not leak the page
URL as `Referer`. `extension/src/components/FloatingToolbar.ts` (~line 211):

```diff
-    if (this.#avatarUrl) {
+    if (this.#avatarUrl && /^https:\/\//i.test(this.#avatarUrl)) {
       const img = document.createElement('img');
       img.src = this.#avatarUrl;
+      img.referrerPolicy = 'no-referrer';
```

### Extension — realtime after server-initiated disconnect (PP-02)

A removed/demoted/logged-out user's sockets are now disconnected by the server (`reason === 'io server disconnect'`,
which `socket.io-client` does **not** auto-reconnect from). The extension's sync layer should treat that reason as
"re-authenticate": call `POST /api/v1/auth/refresh`; on 401 clear `pinpoint_auth_token` and show the signed-out state
instead of retrying with the revoked bearer (a retry would loop on `Invalid or expired token`).

### Extension / widget — nothing else required

No extension or widget change is needed for PP-01, PP-03 – PP-05, PP-14 or PP-21. (Unrelated, observed while running the
full suite: `extension/src/lib/connectionMonitor.ts` imports `@pinpoint/shared/dist/signal.js`, which the root Vitest
alias maps to `shared/src/index.ts/dist/signal.js`, so 18 extension test files fail to load; import `signal` from
`@pinpoint/shared` instead.)

### Dashboard — read the `__Host-fl_csrf` cookie (PP-15)

On a Secure deployment (`COOKIE_INSECURE` unset) the server now names the CSRF cookie `__Host-fl_csrf` (and the session
cookie `__Host-fl_session`, which is HttpOnly and never read by the dashboard). The dashboard only reads the cookie as a
fallback after a hard refresh (the login response body is held in memory otherwise), so until this lands a reloaded tab
on a Secure deployment sends no `X-CSRF-Token` and mutations fail with `CSRF_INVALID` until the user logs in again. The
local stack (`COOKIE_INSECURE=true`) keeps `fl_csrf` and is unaffected. In `dashboard/src/lib/auth.ts`, `readCsrfCookie()`:

```diff
   for (const part of document.cookie.split(';')) {
     const [rawName, ...rest] = part.split('=');
-    if (rawName?.trim() === 'fl_csrf') {
+    const name = rawName?.trim();
+    if (name === '__Host-fl_csrf' || name === 'fl_csrf') {
       const value = decodeURIComponent(rest.join('=').trim());
```

The CSRF value is now `<48 hex>.<64 hex>` (session-bound); the dashboard treats it as opaque, so nothing else changes. Extension
(Bearer) and widget are unaffected. `dashboard/src/lib/api.test.ts` / `auth` tests that set `document.cookie = 'fl_csrf=…'` keep
passing; add one case for `__Host-fl_csrf=…`.

### E2E — `e2e/teams.spec.ts` (PP-04 behaviour change)

`teams.spec.ts` ("create team, invite member, change role, remove member", `--project=api`) registers a brand-new user
(own personal org) and invites that e-mail to a team of the seed account. Cross-org team invites are now (by design) a
uniform `404`, so the test fails at `expect(inviteRes.ok()).toBe(true)`. Fix: make the invitee an org member first,
exactly like `e2e/browser/interactions.spec.ts` already does for its teammate (`inviteWithKnownToken` +
`acceptAndSwitch` from `e2e/browser/demo.ts`, or an `ensureUser`-style helper that inserts the membership), then invite.
`e2e/browser/interactions.spec.ts` and `ui-audit.spec.ts` already invite same-org users and are unaffected.

### Scripts

`scripts/demo-seed.mts` prints portal links as `/api/v1/portals/<slug>/info`; now that `/portal/:slug` exists it should
print `${APP_URL}/portal/<slug>` (the page requests its own magic link).
