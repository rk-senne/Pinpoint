# Pinpoint — Product & UX Strategy

**Version:** 1.0 | **Date:** 22 May 2026 | **Status:** Draft

---

## Product Vision

> Make website feedback as effortless as pointing at a screen — eliminate the friction between seeing an issue and resolving it.

---

## Design Principles

1. **Capture in context** — Never ask users to leave the page to give feedback
2. **Zero-config start** — Signup to first annotation in <3 minutes
3. **Progressive disclosure** — Simple defaults, reveal power features as teams grow
4. **Async-first** — Design for distributed teams; real-time is a bonus
5. **Transparency of state** — Every item has a clear, visible status

---

## Core Flow: Annotate → Assign → Resolve → Report

1. **Annotate** (Extension): Click element → comment + priority + assignee → submit
2. **Assign** (Dashboard): Auto-rules or manual, notification sent
3. **Resolve** (Dashboard): Status change, resolution comment, reporter notified
4. **Report** (Dashboard): Weekly digest, analytics widgets, PDF export

---

## Dashboard Views

### Project Overview
- Card grid with progress rings, sparklines, open/resolved counts
- Quick-action: "+ New Feedback"

### Feedback List
- Filterable table (status, priority, assignee, category, date, URL)
- Bulk actions (assign, status change, delete)
- Saved views ("My Open Bugs")

### Feedback Detail
- Left: screenshot with annotation overlay + device metadata
- Right: status/assignee/priority + activity timeline + comments

### Kanban Board
- Columns: Open | In Progress | Resolved | Closed
- Drag-and-drop status changes
- Swimlanes by assignee/priority/category

### Team Settings & Billing
- Members (invite, roles), Integrations (OAuth connect), Notifications, Billing (Stripe portal)

---

## Extension UX Improvements

- **Keyboard shortcut:** `Ctrl+Shift+F` for instant capture
- **Smart element detection:** Highlight nearest semantic element on hover
- **Quick mode:** Shift+click = submit with defaults (no form)
- **Offline queue:** IndexedDB storage, auto-sync on reconnect, badge count
- **Status indicators:** Green (synced), orange (pending), red (error)

---

## Onboarding (4 steps)

1. Sign up (social auth, no credit card)
2. Create project (name + URL, auto-fetch favicon)
3. Install extension (Chrome Web Store link + validation)
4. First annotation (guided tutorial overlay with confetti on success)

---

## Collaboration Features

- Real-time cursors on dashboard (WebSocket presence)
- Typing indicators in comment threads
- @mentions with autocomplete
- Collaborative annotation (see teammates' in-progress pins)
- Project activity feed (live stream of events)

---

## Reporting & Analytics

| Widget | Type | Description |
|--------|------|-------------|
| Resolution Time | Line chart | Avg Open → Resolved over time |
| Feedback Volume | Bar chart | New items per day/week |
| Status Breakdown | Donut | Current distribution |
| Team Activity | Stacked bar | Items resolved per member |
| Top Pages | Ranked list | Pages with most feedback |
| Overdue Items | Count + list | Open longer than SLA |

---

## Mobile Strategy

- Responsive dashboard (not a separate app)
- Phone: review-only (card list, detail view, comments)
- Tablet: full functionality (compact table, side-by-side detail)
- Swipe gestures: right = resolve, left = assign

---

## Accessibility (WCAG 2.2 AA)

- 4.5:1 contrast, never color-only indicators
- Full keyboard navigation, visible focus rings
- Screen reader support (aria-live for dynamic content)
- Respect `prefers-reduced-motion`
- Drag-and-drop has keyboard alternatives

---

## Implementation Priority

| Phase | Scope | Weeks |
|-------|-------|-------|
| P0 | Dashboard redesign (list + detail), extension speed, onboarding | 1-6 |
| P1 | Kanban, @mentions, notifications, real-time presence | 7-12 |
| P2 | Reporting, SLA tracking, integrations, billing UI | 13-18 |
| P3 | Mobile responsive, offline queue, accessibility audit | 19-24 |
