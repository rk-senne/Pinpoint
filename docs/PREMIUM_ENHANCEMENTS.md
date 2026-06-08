# Pinpoint — Premium Enhancements Documentation

> All features below have been scaffolded. This document details architecture, integration points, and what remains to production-ready each feature.

---

## 1. AI Feedback Triage

**File:** `server/src/services/triage.ts`

**What it does:**
- Auto-classifies severity based on keyword analysis (critical/major/minor/informational)
- Detects duplicate feedback using trigram-based text similarity (threshold: 60%)
- Suggests assignees based on who previously resolved issues on the same CSS selector
- Auto-tags feedback (mobile, performance, design, copy)

**How it works:**
```
New annotation → triageService.triage(orgId, body, target)
  → keyword severity classification
  → trigram similarity search against last 100 active annotations
  → selector-based assignee lookup from resolved history
  → return { suggestedSeverity, suggestedAssignee, duplicates[], tags[] }
```

**Integration point:** Call from the annotation creation route after persist. Surface suggestions in the dashboard annotation detail view.

**To production-ready:**
- [ ] Replace keyword heuristics with OpenAI classification (`gpt-4o-mini`)
- [ ] Use pgvector embeddings for semantic duplicate detection instead of trigrams
- [ ] Add confidence thresholds before auto-applying suggestions
- [ ] Store triage results on the annotation row for audit trail

---

## 2. Session Replay Snippets

**File:** `extension/src/lib/sessionReplay.ts`

**What it does:**
- Records the last 10 seconds of user interaction before an annotation is created
- Captures: mouse moves (50ms throttle), clicks, scrolls, input changes, DOM mutations, window resizes
- Circular buffer automatically prunes events older than 10 seconds
- Outputs a JSON snapshot that can be played back in the dashboard

**Recording format:**
```typescript
interface ReplayEvent {
  type: 'mousemove' | 'click' | 'scroll' | 'input' | 'mutation' | 'resize';
  timestamp: number; // epoch ms
  data: unknown;     // type-specific payload
}
```

**Integration point:** 
1. Start recording on content script injection: `recorder.start()`
2. On annotation create: `const replay = recorder.getSnapshot(10)`
3. Attach to annotation payload: `{ ...annotation, sessionReplay: replay }`
4. Store in S3 alongside screenshot (or inline in JSONB for small replays)

**To production-ready:**
- [ ] Add replay player component in dashboard (canvas-based or DOM recreation)
- [ ] Compress replay data before upload (typical 10s = ~5-15KB JSON)
- [ ] Add privacy controls (mask input values, exclude password fields)
- [ ] Add `data-pinpoint-ignore` attribute to exclude elements from recording

---

## 3. Feedback Heatmaps

**File:** `server/src/adapters/inbound/http/heatmap.routes.ts`

**Endpoint:** `GET /api/v1/projects/:projectId/heatmap?pageUrl=...`

**What it does:**
- Aggregates annotation pin positions into a 50×50px grid
- Returns cell data with count + severity breakdown
- Filterable by page URL

**Response shape:**
```json
{
  "cellSize": 50,
  "totalAnnotations": 47,
  "cells": [
    { "x": 150, "y": 300, "count": 8, "severities": { "critical": 2, "major": 4, "minor": 2 } },
    { "x": 400, "y": 100, "count": 5, "severities": { "minor": 5 } }
  ]
}
```

**Integration point:** Dashboard project view renders an overlay on a page screenshot using the cell data. Color intensity = count, color hue = worst severity in cell.

**To production-ready:**
- [ ] Dashboard heatmap visualization component (canvas overlay on screenshot)
- [ ] Date range filter (last 7/30/90 days)
- [ ] Normalized coordinates (percentage-based for responsive pages)
- [ ] Cache results (invalidate on new annotation)

---

## 4. Design System Violation Detection

**File:** `extension/src/lib/designSystemChecker.ts`

**What it does:**
- When a user annotates an element, scans its computed styles against design tokens
- Checks: font-size, padding/margin (4px grid), border-radius, text color, background color
- Reports violations with actual vs expected values + severity (error/warning)

**Design tokens format:**
```typescript
interface DesignToken {
  fontSizes: number[];       // [12, 14, 16, 18, 20, 24, 30, 36, 48]
  spacing: number[];         // [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]
  colors: string[];          // ['#4f46e5', '#10b981', ...]
  borderRadii: number[];     // [0, 2, 4, 6, 8, 12, 16, 9999]
}
```

**Integration point:**
1. Project settings: upload/configure design tokens (JSON or Figma API import)
2. On annotation create: `const violations = checkDesignViolations(element, tokens)`
3. Display violations in annotation detail as auto-detected issues

**To production-ready:**
- [ ] Design token editor in project settings
- [ ] Figma Tokens plugin integration (auto-sync tokens from Figma)
- [ ] Tailwind CSS config parser (extract values from `tailwind.config.js`)
- [ ] Severity auto-escalation (3+ violations on same element = "major")

---

## 5. Approval Workflows

**Files:** `server/src/migrations/20260602000006_approval_workflows.ts`, `server/src/adapters/inbound/http/premium.routes.ts`

**What it does:**
- Define multi-step review chains per project (e.g., Designer → Developer → Designer verify)
- Start an approval instance for an annotation
- Track step history (who approved, when)
- Auto-close annotation when all steps complete

**API:**
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/approvals/workflows | Create workflow |
| GET | /api/v1/approvals/workflows | List org workflows |
| POST | /api/v1/approvals/start | Start instance for annotation |
| POST | /api/v1/approvals/:instanceId/advance | Approve current step |

**Workflow step format:**
```json
[
  { "role": "designer", "action": "annotate", "label": "Design Review" },
  { "role": "developer", "action": "implement", "label": "Implementation" },
  { "role": "designer", "action": "verify", "label": "Design Verification" }
]
```

**To production-ready:**
- [ ] Reject/request-changes action (sends back to previous step)
- [ ] Email notifications at each step transition
- [ ] Dashboard UI for workflow configuration (drag-and-drop steps)
- [ ] Timeout handling (auto-escalate if step not completed in X hours)

---

## 6. Client Satisfaction Scoring (CSAT)

**Files:** `server/src/migrations/20260602000007_satisfaction_scores.ts`, `premium.routes.ts`

**What it does:**
- After an annotation is resolved, sends a one-time rating link to the reporter
- Reporter clicks link, rates 1-5 stars + optional comment
- Org-wide CSAT summary (average score, total ratings)

**API:**
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/v1/csat/request | Bearer | Generate rating token for resolved annotation |
| POST | /api/v1/csat/rate/:token | None | Submit 1-5 rating |
| GET | /api/v1/csat/summary | Bearer | Org average + count |

**Flow:**
```
Annotation resolved → POST /csat/request → generates token
  → Email to reporter with link: /rate/{token}
  → Reporter submits score → stored with annotation reference
  → Dashboard shows CSAT trends
```

**To production-ready:**
- [ ] Auto-trigger on status change to "resolved" (via automation rules)
- [ ] Email template with branded rating buttons
- [ ] Per-team-member CSAT breakdown
- [ ] CSAT trend chart in reporting dashboard

---

## 7. Live Collaboration Cursors

**File:** `extension/src/lib/liveCursors.ts`

**What it does:**
- When two teammates are on the same page with Pinpoint active, they see each other's cursors in real-time
- Throttled at 100ms (10 updates/sec) to avoid flooding
- Cursors show teammate's name (extracted from email) with colored SVG pointer

**Architecture:**
```
User A: mousemove → throttle → socket.emit('cursor:move', {x, y, userId, pageUrl})
Server: broadcast to project room (excluding sender)
User B: socket.on('cursor:move') → renderRemoteCursor({x, y, email})
```

**Integration point:** The collab gateway already has project rooms. Add `cursor:move` as a broadcast-only event (no persistence needed).

**To production-ready:**
- [ ] Add cursor:move handler in collab.gateway.ts (relay to room, exclude sender)
- [ ] Cursor cleanup on disconnect (fade out + remove after 3s)
- [ ] Page URL matching (only show cursors from users on same page)
- [ ] Color assignment per user (consistent hash of userId → hue)

---

## 8. Embed Widget

**File:** `extension/src/embed/widget.ts`

**What it does:**
- Self-contained `<script>` tag that adds a floating feedback button to any website
- No browser extension required — dramatically expands addressable market
- Opens a minimal form (email + description) on click
- Submits directly to `POST /api/v1/feedback`

**Usage:**
```html
<script src="https://cdn.pinpoint.app/widget.js"
        data-project="PROJECT_UUID"
        data-api="https://api.pinpoint.app"
        data-color="#4f46e5"></script>
```

**Features:**
- Floating action button (bottom-right, customizable color)
- Slide-up panel with email + textarea
- Auto-captures: page URL, viewport size, browser user agent
- Success state with auto-dismiss

**To production-ready:**
- [ ] Add screenshot capture (html2canvas or similar)
- [ ] Build as standalone bundle (no extension dependencies), host on CDN
- [ ] Add annotation mode (click-to-pin on the page)
- [ ] Rate limiting (prevent spam submissions)
- [ ] Configurable position (bottom-left, bottom-right)
- [ ] Dark mode support

---

## 9. Public Feedback Board

**Files:** `server/src/migrations/20260602000008_feedback_boards.ts`, `premium.routes.ts`

**What it does:**
- Canny/Nolt-style public board where end users submit and vote on feedback
- No account required (email-based voting with dedup)
- Status tracking (open → planned → in progress → done)
- Feeds into the same annotation pipeline

**API:**
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/v1/boards | Bearer | Create board |
| GET | /api/v1/board/:slug | None | View board + posts |
| POST | /api/v1/board/:slug/posts | None | Submit post |
| POST | /api/v1/board/:slug/posts/:id/vote | None | Vote (email-deduplicated) |

**Data model:**
- `feedback_boards`: org-level config (slug, title, allow_submissions)
- `board_posts`: user submissions (title, body, author_email, vote_count, status)
- `board_votes`: dedup table (post_id + voter_email unique)

**To production-ready:**
- [ ] Dashboard page to manage boards and update post statuses
- [ ] Public board frontend (standalone HTML page or React widget)
- [ ] Email verification for voters (prevent spam)
- [ ] Admin can convert board post → annotation (link to project)
- [ ] Search + category filtering

---

## 10. Daily Digest with AI Insights

**File:** `server/src/services/dailyDigest.ts`

**What it does:**
- Generates a daily summary of org activity (last 24 hours)
- Metrics: new annotations, resolved count, avg resolution time, top contributors, hotspot selectors
- Heuristic insight (e.g., "Resolution rate is low — consider clearing the backlog")
- Designed to be sent via the existing notification queue (email or in-app)

**Output:**
```typescript
interface DigestData {
  period: string;
  newAnnotations: number;
  resolved: number;
  avgResolutionHours: number | null;
  topContributors: { email: string; count: number }[];
  hotspots: { selector: string; count: number }[];
  insight: string;
}
```

**To production-ready:**
- [ ] Cron job / scheduled worker (runs daily at 9am per org timezone)
- [ ] Replace heuristic insight with OpenAI-generated summary
- [ ] Email template (branded, with mini charts)
- [ ] User preference: opt-in/out of digest
- [ ] Weekly digest option alongside daily

---

## 11. Smart Resolution Suggestions

**File:** `server/src/services/smartSuggestions.ts`

**What it does:**
- When a developer views an annotation, surfaces hints about what to fix
- Searches resolved annotations with similar CSS selectors
- Extracts likely component names from selectors (e.g., `.Button` → `Button.tsx`)
- Suggests assignee based on who resolves the most issues

**API:** `GET /api/v1/annotations/:id/suggestions`

**Response:**
```json
{
  "suggestions": [
    { "type": "past_fix", "title": "Similar issue resolved", "detail": "...", "confidence": 0.7 },
    { "type": "related_component", "title": "Likely component: CheckoutButton", "detail": "Check CheckoutButton.tsx", "confidence": 0.6 },
    { "type": "assignee", "title": "Suggest assigning to sarah@...", "detail": "Resolved 12 issues", "confidence": 0.5 }
  ]
}
```

**To production-ready:**
- [ ] Git integration: search repo for files matching the component name
- [ ] Show relevant recent commits on the detected component
- [ ] OpenAI: generate a fix description based on past resolution patterns
- [ ] Cache suggestions (invalidate on annotation update)

---

## 12. Visual Regression Detection

**File:** `server/src/services/visualRegression.ts`

**What it does:**
- Compares a baseline screenshot (from when annotation was created) against a fresh capture
- Pixel-by-pixel diff using sharp (already a project dependency)
- Reports: match (boolean), diff percentage, status (identical/minor/significant/completely_different)

**API:** `POST /api/v1/annotations/:id/regression-check` (upload new screenshot)

**Algorithm:**
1. Resize both images to 800px width
2. Compare raw pixel buffers channel-by-channel
3. Pixel differs if average channel delta > 30
4. Diff percentage = diffPixels / totalPixels

**Status thresholds:**
| Diff % | Status |
|--------|--------|
| 0% | identical |
| < 2% | minor_change |
| < 15% | significant_change |
| ≥ 15% | completely_different |

**To production-ready:**
- [ ] Scheduled regression checks (nightly re-capture of resolved annotations)
- [ ] Perceptual hash (pHash) or SSIM for more robust comparison
- [ ] Ignore regions (exclude dynamic content like dates, ads)
- [ ] Auto-reopen annotation if regression detected on "resolved" item
- [ ] Visual diff overlay in dashboard (highlight changed pixels in red)

---

## 13. White-Label Portal

**File:** `server/src/migrations/20260602000009_white_label.ts`

**What it does:**
- Extends the client_portals table with full brand customization fields
- Agencies can serve the feedback portal on their own domain
- Custom favicon, font family, CSS overrides, company name
- Option to completely hide Pinpoint branding

**New columns on `client_portals`:**
| Column | Type | Description |
|--------|------|-------------|
| custom_domain | varchar(255) | e.g., `feedback.clientsite.com` |
| favicon_url | varchar(2048) | Custom favicon |
| font_family | varchar(100) | e.g., `Inter, sans-serif` |
| custom_css | jsonb | CSS overrides for buttons, headers, etc. |
| hide_pinpoint_branding | boolean | Remove "Powered by Pinpoint" |
| support_email | varchar(255) | Reply-to for notifications |
| company_name | varchar(255) | Agency's brand name |

**To production-ready:**
- [ ] DNS verification flow (TXT record validation)
- [ ] SSL certificate provisioning (Let's Encrypt via API, or Cloudflare for SaaS)
- [ ] Portal renderer that applies white-label config to templates
- [ ] Plan gating: white-label only on Enterprise tier
- [ ] Preview mode in settings before going live

---

## Wiring Summary

To connect these features to the existing app, the following routes need to be mounted in `composition/container.ts`:

```typescript
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/webhooks', webhooksRouter);
app.use('/api/v1/reports', reportingRouter);
app.use('/api/v1/projects', heatmapRouter); // heatmap is nested under projects
app.use('/api/v1/portals', clientPortalRouter);
app.use('/api/v1/workflows', workflowRouter);
app.use('/api/v1', premiumRouter); // boards, csat, approvals
app.get('/api/v1/docs.json', serveApiDocs);
```

Middleware to apply:
```typescript
app.use('/api/v1', tenantRateLimit()); // after auth middleware
```

Extension modules to initialize in `content.ts`:
```typescript
import { SessionReplayRecorder } from './lib/sessionReplay';
import { checkDesignViolations } from './lib/designSystemChecker';
import { startCursorBroadcast } from './lib/liveCursors';
import { registerShortcutListeners } from './lib/keyboardShortcuts'; // in background.ts
```

---

## Run migrations

```bash
npx knex migrate:latest --knexfile server/knexfile.ts
```

New migrations (in order):
1. `20260602000002_user_notifications.ts`
2. `20260602000003_webhook_endpoints.ts`
3. `20260602000004_client_portals.ts`
4. `20260602000005_workflow_automation.ts`
5. `20260602000006_approval_workflows.ts`
6. `20260602000007_satisfaction_scores.ts`
7. `20260602000008_feedback_boards.ts`
8. `20260602000009_white_label.ts`
