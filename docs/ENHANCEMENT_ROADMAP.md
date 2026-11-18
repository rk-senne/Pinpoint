# Pinpoint Enhancement Roadmap — Plug-Anywhere · Intuitive · Parity

> **Status (2026-11-15, branch `feat/enhancement-roadmap`, uncommitted): all missions A1–A9, B1–B5, C1–C5 and GAP 1–8 implemented, including the GAP 6 file splits.**
> Verified: typecheck, lint and build clean; 2047 unit + integration tests green against a real Postgres; Playwright 22/22 (API, real dashboard UI in Chromium, real MV3 extension in Chromium); production-image simulation passes (migrate, health, widget asset, `/metrics` token, clean SIGTERM). All migrations apply, roll back and re-apply.
>
> GAP 6 splits now DONE: `Popover.ts` 113 KB → 94 KB (styles, template and helpers extracted to `extension/src/components/popover/`), and the dashboard templates are lazy-loaded (`index.html` 89.5 KB → 73.8 KB, 6 lazy routes: `/shared/:linkId`, `/review/:linkId`, `/reports`, `/workflows`, `/integrations`, `/portals`).
>
> Defects found only by running against the real stack (fixed this session):
> - Self-registered users could never log in — no org existed. First verified login now provisions a personal org.
> - Projects, annotations and comments were created with NULL `org_id`.
> - Annotation diagnostics/replay were stripped by the route schema and never serialized.
> - `api_keys.key_prefix` `varchar(8)` overflowed.
> - Widget CORS preflight was rejected by real browsers; the widget bundle was blocked cross-origin by CORP.
> - The MV3 extension was rejected by Chrome (invalid shortcuts), could not mount (`customElements` is null in the isolated world) and could not call the API (page-origin CORS) — fixed with a polyfill and a service-worker API relay.
> - The dashboard read the wrong response shape in 4 places; the Send-to menu crashed on a TDZ error.
> - Realtime and mutations broke after a page reload (CSRF/bearer held only in memory).
> - The review iframe recursively framed the SPA and was blocked by `X-Frame-Options: DENY`.
> - SIGTERM exited 1 without closing the DB; migrations could not connect in production (`DATABASE_URL`-only) and CI never ran them inside the VPC.
> - Webhook queue double-send; heatmap SQL; SSRF IPv6 bypass.
>
> Still open: the ECR repo is `IMMUTABLE` while deploys push `:latest`, and `ecs.tf` defines no `OAUTH_STATE_SECRET` secret (see `docs/DEPLOYMENT.md`).

> **Earlier status (2026-11-13):** all missions A1–A9, B1–B5, C1–C5 and GAP 1–8 implemented.
> Verified with a real `tsc --build` typecheck, lint, full build, and 1967 tests green ×3 against a real Postgres (0 skipped). All 42 migrations apply, roll back fully, and re-apply.
>
> Defects found only by running against real Postgres or by the independent security audit, all fixed with regression tests:
> - Migrations importing app code crashed under ts-node (`migrate:latest` stopped at `…000101`).
> - Heatmap SQL referenced a non-existent column, counted severity groups instead of annotations, and could cast junk text before the guard.
> - SSRF guard bypass via hex IPv4-mapped IPv6 (`::ffff:a9fe:a9fe` → IMDS). Now byte-level IPv6 classification, which also blocks NAT64, 6to4 and IPv4-compatible forms.
> - Widget and guest submissions inserted `author_id='guest'` / `page_id=projectId`, so every real submission failed. Fixed with nullable `author_id`, an author-XOR-guest CHECK, and `CreateGuestAnnotation` with atomic pins.
> - Webhook queue double-claim: locks were released before the send, so concurrent workers re-sent deliveries. Fixed with a lease-based atomic claim.
> - Webhook `events` was JSON-stringified into a `text[]` column, so endpoint creation always failed. This predates the branch.
> - The root `typecheck` script type-checked nothing (`tsc --noEmit` on a `files: []` solution config); it now runs `tsc --build`.
>
> Guest reply tokens and guest confirmation emails (A7.5/A7.6) were not built because no such feature exists to harden.

> Produced by the moonbase council pipeline (numbuh-1 requirements → numbuh-2 architecture → numbuh-274 security → numbuh-0 consolidation) on 2026-11-13, grounded in code read on branch `feat/full-platform-wiring` and verified web/market research (Nov 2026). Every mission cites real files. References `docs/GAP_SPEC.md` (GAP 1–8) without re-planning it.

> **Security pass (2026-11-15):** a two-part audit (application security + supply chain/clients) found 1 critical and ~12 high issues; all are fixed with tests. The critical one was that review-link frames ran third-party script with the dashboard's origin; they are now opaque-origin sandboxed and talk to the page only via validated postMessage. The highs:
> - missing project/org/role checks on annotations, comments and newer routes
> - sessions not revoked by logout or member removal (`token_version` now enforced)
> - credentials in request logs
> - SSRF guard broken on Node 26 and bypassable via redirects
> - login lockout and enumeration
> - OAuth pre-hijack
> - invitation/portal tokens returned in responses
> - over-broad API-key reach
>
> `npm audit`: 33 → 3 (moderate, dev-only `minimatch` inside the ESLint parser; no stable typescript-eslint release accepts a patched minimatch yet). Upgraded: nodemailer 10, sharp 0.35, vitest 4, zod 4, @typescript-eslint/parser 8. Verified: forced typecheck, lint, build, 2378 tests ×2 on real Postgres, Playwright 24/24, production image simulation.
>
> Open decision: the extension bearer still lives in `chrome.storage.local`. Our content scripts no longer read it, but moving it to `chrome.storage.session` would also stop code running inside the extension's content-script world from reading it, at the cost of signing in again after each browser restart.

## Executive summary
Pinpoint is functionally solid (typecheck clean, 1558 tests). Two of three page-reach mechanisms ship today: a Chrome extension and a `<script>` widget (`widget/src/index.ts`). Outbound webhooks, OAuth integrations (HMAC-signed state), a durable notification queue, AuditLog, `statement_timeout`, and Redis-in-compose are wired.

**Key finding:** the gap between "wired" and "safe to expose to arbitrary customer infrastructure" is the entire job of Pillar A. The threat model found 4 architectural blockers that make plug-anywhere dead-on-arrival in prod today:
1. CORS is globally locked to the dashboard origin with `credentials:true`; `validateConfig` refuses prod boot on `*` — every cross-origin widget request is browser-blocked.
2. The widget key resolves via `.orderBy('created_at','asc').first()` — a leaked key is an org-wide cross-project write primitive.
3. No SSRF egress guard on any outbound fetch — a webhook URL of `http://169.254.169.254/…` reads cloud IMDS creds, and `responseBody` is persisted verbatim.
4. `inputSanitizer` only strips null bytes + trims — untrusted widget/guest text flows into dashboard + CSV export with no HTML-escape or formula-injection guard.

Phase 1 hardens these; Pillars B and C build on top.

## Competitive positioning
| Capability | Marker.io | BugHerd | Pastel | QualityHive | Userback | Pinpoint today | Target |
|---|---|---|---|---|---|---|---|
| Browser extension | ✓ | ✓ | – | ✓ | ✓ | ✓ shipped | keep |
| `<script>` widget | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (unsafe to expose) | A1–A3 |
| Proxy / review-link (no install) | ✓ | ✓ | ✓ | ✓ | – | ✗ gap | C1 |
| No reviewer login | ✓ | ✓ | ✓ | ✓ | ✓ | partial (guest links) | A7 |
| Auto browser/OS/screen metadata | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`parseUserAgent`) | keep |
| JS-error + console capture | ✓ | ✓ | – | ✓ | ✓ | ✗ gap | C2 |
| Screenshot / session replay | ✓ | ✓ | ✓ | ✓ | ✓ | partial | C3 |
| One-click → Jira/Linear/GitHub/ClickUp/Asana | ✓ | ✓ | partial | ✓ | ✓ | integrations wired, no push | C4 |
| Outbound webhooks (signed) | ✓ | ✓ | – | ✓ | ✓ | HMAC body-only | A5b |
| Self-host | – | – | – | – | – | documented, unsafe defaults | A9 (wedge) |
| MCP server | – | – | – | ✓ | – | ✗ gap | C5 (wedge) |

Two defensible wedges no/few competitors have: **safe self-host** and an **MCP server**. Both depend on Phase-1 hardening.

---

## Pillar A — Embeddability / plug into any infrastructure

- **A1 — Widget key isolation** (M). `pk_widget_`-prefixed key bound to one `project_id`; kill the org-first write target; reject widget keys used as Bearer. Files: `widget.routes.ts`, `middleware/apiKeyAuth.ts`, `ApiKeyRepo.ts`+migration, `apiKeys.routes.ts`. Security gate.
- **A2 — Dedicated `/api/v1/widget/*` CORS** (M). Credential-free CORS reflecting `Origin` only on per-key `allowed_origins`; global strict cookie/CSRF policy untouched. NEW `middleware/widgetCors.ts`. Dep: A1.
- **A3 — Redis fail-closed widget rate limit + per-key daily quota** (M). Replace in-memory 5/min. Files: `tenantRateLimit.ts`, NEW `widgetRateLimit.ts`, `planLimits.ts`. Dep: A1.
- **A4 — Encrypt integration tokens at rest; never log** (M). Encrypt access/refresh tokens + `clientSecret`; pino redaction. Dep: precedes A5b.
- **A5a — SSRF egress guard on every outbound fetch** (M). Deny private/link-local/loopback + IMDS; https-only; DNS-pin. NEW `services/egressGuard.ts`; applied in `DispatchWebhook`, `integrationTokenRefresh`; ECS IMDSv2 hop-limit 1. Unblocks all outbound.
- **A5b — standard-webhooks signing + durable queued dispatch** (L). Sign `{msgId}.{ts}.{body}`, emit standard headers, `whsec_` secret, move dispatch onto the notification-queue worker so SIGTERM mid-backoff can't drop deliveries. Deps: A5a, A4.
- **A7 — Finish guest / no-login reviewer access** (M). Redis per-link quota, unverified-author marking, ≥128-bit non-enumerable `linkId`, scoped/expiring reply tokens, canonical error envelope. Deps: A3, B1.
- **A9 — Self-host preflight independent of NODE_ENV** (M). Run config preflight on any non-localhost bind; reject weak JWT, `CORS_ORIGIN=*`, insecure cookies, default DB password, missing signing secrets. Dep: A5b.
- **A-cleanup — Delete `extension/src/embed/widget.ts`** (S). Legacy embed (no Shadow DOM, unauthenticated POST).

## Pillar B — Intuitive UI/UX

- **B1 — Shared `textContent` render helper** (M). One `shared/src/safeText.ts`; all guest/widget text as `textContent`, never `innerHTML`; fix widget `showMessage()`. Primary stored-XSS mitigation. Unblocks A7.
- **B2 — CSV formula-injection escaping + server-side body cap** (S). Prefix `= + - @ \t \r` cells; enforce length caps server-side.
- **B3 — Onboarding: copy-paste snippet + live install verification** (M). `OnboardingWizard` issues a `pk_widget_` key, shows the exact `<script>` snippet with resolved `apiUrl`, polls for first feedback. Tiny interface hiding complexity (Ousterhout). Dep: A1.
- **B4 — Premium-page theme tokens** (S). = GAP 8: swap hardcoded hex for `@pinpoint/shared/theme`; dynamic content via DOM.
- **B5 — UI unit-test coverage** (M). = GAP 2: 9 under-tested modules; pull forward ReplayPlayer/HeatmapOverlay/NotificationBell/IntegrationsPage/OnboardingWizard.

## Pillar C — Competitive feature parity

- **C1 — Proxy / review-link (load live site, no install)** (L). The missing third reach mechanism. NEW `proxy.routes.ts` + `ReviewLinkPage.ts`, reusing A7 guest flow. Proxy fetch must pass A5a. Deps: A5a, A7.
- **C2 — JS-error + console capture** (M). Bounded, PII-aware capture on widget/extension, additive schema. Render via B1, cap via B2. Dep: B1.
- **C3 — Session-replay completeness** (M–L). `ReplayPlayer.ts` is already a complete RAF player; close capture-side gaps + add the missing test; apply redaction before persistence. Dep: C2.
- **C4 — One-click delivery → Jira/Linear/GitHub/ClickUp/Asana** (L). Turn wired integrations into trackable-task creation; store external id/URL on the annotation; "Send to…" action. Thin-CRUD per ADR-006. Deps: A4, A5a, A5b.
- **C5 — MCP server** (L). NEW `mcp-server/` workspace exposing read + triage tools over MCP via a dedicated scoped API key (reuse A1 model). Dep: A1.

---

## Phased sequence
**Phase 1 — Make built surfaces safe to turn on (critical path).** A1 → A2 → A3 (widget safe), A5a (egress guard), B1 + B2 (XSS/CSV), A4 → A5b (webhooks/integrations safe), A7 (guest finished), A9 (self-host safe), A-cleanup. Pull GAP 1 (Nielsen auto-seed, P0) alongside. **Exit gate:** all 12 security Hard-Requirement items green; the A2 cross-origin accept/reject test and the B1 XSS-payload test are blocking checks.

**Phase 2 — Differentiating reach + delivery.** C1 (proxy review-link), C2 (JS-error/console capture), C4 (one-click task delivery — headline parity), B3 (onboarding snippet + verify), B4 (theme tokens).

**Phase 3 — Polish / completeness / ecosystem.** C3 (replay completeness), C5 (MCP server), B5 (finish GAP 2), remaining GAP_SPEC P2s (local email sink, dead scaffolding, heatmap SQL, error-envelope). Defer big-file splits unless size becomes demonstrated friction.

## Already shipped — do NOT re-plan
- Widget core (`widget/src/index.ts`): closed Shadow DOM, `Pinpoint.init`, `/api/v1/widget/feedback`, self-host documented — harden via A1–A3.
- Org-scoped IDOR checks (`feedback.routes.ts`).
- HMAC-signed orgId-in-cookie OAuth state (`oauth.routes.ts`, `integrations.routes.ts`), constant-time compare — DO NOT TOUCH through A4/C4.
- Prod `JWT_SECRET` + CORS-wildcard boot guard (`config.ts`) — A9 extends it, keeps prod behavior.
- Durable notification queue (SELECT…FOR UPDATE SKIP LOCKED, retry/backoff) — A5b reuses it, no new infra.
- `ReplayPlayer.ts` — complete RAF playback (only its test was missing).
- Thin-CRUD for premium routes — ADR-006 Accepted; no hexagonal extraction.
- Safety backbone: `statement_timeout=30000`, `AbortSignal.timeout(10_000)`, 1 MB body cap, Zod+caps on guest feedback, Redis in compose, CD pipelines.
- `GAP_SPEC.md` GAP 1–8 — referenced and sequenced here, not re-authored.
- GAP_SPEC already-fixed items (OAuth-callback IDOR, statement_timeout, analytics cache invalidation, local Redis, CD pipeline) — do not re-open.

## Research basis
- **Market (web, Nov 2026):** live-site tools reach the page 3 ways (script/extension/proxy) — Pinpoint has 2, proxy is C1. Table stakes across Marker.io/BugHerd/Pastel/QualityHive/Userback/Feedbucket/ruttl: no reviewer login, auto metadata, JS-error capture, task delivery. QualityHive now markets an MCP server (C5).
- **Ousterhout, *A Philosophy of Software Design* (moonbase KB):** deep modules, general-purpose over specialized, information hiding → the embed SDK exposes a tiny `Pinpoint.init({projectKey})` surface (A1/B3); MCP exposes few deep tools (C5).
- **Dynowski & Dulak, *Learning API Styles* (moonbase KB):** webhooks need HMAC+timestamp signing, IP allowlist, delivery guarantees (store/queue/retry + consumer dedupe), additive-field versioning, standard-webhooks spec → A5a/A5b.
- **Newman, *Monolith to Microservices* (moonbase KB):** event-driven decoupling and "just enough" shared domain → the integration/plug-in architecture (C4) riding the existing event bus.
