# ADR-005: Offline-First Extension with Outbox Pattern

## Status

Accepted

## Date

2025-05-24

## Context

Pinpoint users create annotations while reviewing websites. Common scenarios
where connectivity is unreliable:

- Reviewing on a plane, train, or in a café with spotty WiFi.
- Corporate networks with aggressive proxy timeouts.
- The Pinpoint API experiencing temporary downtime.

If the extension requires a live connection to submit annotations, users lose
work or are forced to remember and re-enter feedback later. This creates
friction that discourages thorough reviews.

The extension already stores the auth token in `chrome.storage.local`, so
leveraging local storage for pending operations is a natural extension.

## Decision

Implement the **Outbox Pattern** for the Chrome Extension:

### Write path (offline-capable)

1. When the user submits an annotation (or comment, status change, etc.), the
   extension writes the operation to a local **outbox** in
   `chrome.storage.local` as a structured entry:
   ```ts
   interface OutboxEntry {
     id: string;            // UUID, generated client-side
     operation: string;     // e.g., 'CREATE_ANNOTATION', 'ADD_COMMENT'
     payload: unknown;      // the request body
     createdAt: string;     // ISO timestamp
     retryCount: number;    // starts at 0
     status: 'pending' | 'in-flight' | 'failed';
   }
   ```
2. The UI immediately reflects the optimistic result (pin appears, comment
   shows) with a "pending sync" indicator.
3. A background **sync worker** (service worker in MV3) processes the outbox:
   - Picks the oldest `pending` entry.
   - Sends the API request.
   - On success: removes the entry from the outbox.
   - On failure: increments `retryCount`, sets `status = 'failed'`, and
     schedules a retry with **exponential backoff** (1s, 2s, 4s, 8s, …,
     capped at 5 minutes).
4. When connectivity is restored (detected via `navigator.onLine` event +
   periodic health-check ping to `/health`), the worker flushes all pending
   entries in order.

### Read path (cache-first)

- The extension caches the last-known annotations for each page in
  `chrome.storage.local`.
- On page load, the extension renders from cache immediately, then fetches
  fresh data when online.
- Stale data is marked visually (subtle opacity/badge) until confirmed fresh.

### Conflict resolution

- The server is the source of truth. If an outbox entry fails with a `409
  Conflict` (e.g., annotation was already deleted server-side), the entry is
  removed from the outbox and the local state is reconciled with the server
  response.
- Pin numbers are server-assigned (atomic counter); optimistic pins show a
  placeholder (`•`) until the server confirms the number.

## Consequences

### Positive

- **Zero data loss** — annotations created offline are never lost; they sync
  when connectivity returns.
- **Responsive UX** — the UI updates immediately regardless of network state;
  no loading spinners blocking the review flow.
- **Resilient to API downtime** — transient server errors don't interrupt the
  user's workflow.
- **Natural fit for MV3** — the service worker lifecycle aligns with background
  sync; the outbox persists across worker restarts.

### Negative

- **Complexity** — the outbox, retry logic, conflict resolution, and optimistic
  UI add significant implementation surface.
- **Storage limits** — `chrome.storage.local` has a 10 MB quota (expandable
  with `unlimitedStorage` permission). Large volumes of offline annotations
  with screenshots could hit limits.
- **Ordering challenges** — dependent operations (create annotation → add
  comment) must be processed in order; the outbox must maintain causal ordering.
- **Stale reads** — users may see outdated data until the next sync. Must
  communicate staleness clearly in the UI.
- **Testing burden** — offline scenarios, retry logic, and conflict resolution
  require extensive integration and property-based testing.
