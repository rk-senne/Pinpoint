# ADR-001: Vanilla TypeScript + Signals Instead of React

## Status

Accepted

## Date

2025-05-24

## Context

Pinpoint originally used React for both the Dashboard and the Chrome Extension.
As the project matured, several pain points emerged:

- **Bundle size** — React + ReactDOM added ~45 kB (gzipped) to the extension
  content script, which runs on every page the user visits. This impacted load
  time and memory on low-end devices.
- **Shadow DOM friction** — React's synthetic event system conflicts with Shadow
  DOM boundaries. Workarounds (portals, manual event re-dispatch) were brittle
  and leaked implementation details.
- **Conceptual overhead** — the Dashboard UI is largely static templates with
  small reactive islands (annotation lists, real-time status). A full VDOM
  reconciler was overkill.
- **Dependency surface** — React, react-dom, react-router-dom, and the Vite
  plugin added maintenance burden (security patches, breaking upgrades).

The team evaluated alternatives: Preact (smaller but same Shadow DOM issues),
Lit (Web Components native but adds a framework), and vanilla TS with a minimal
reactive primitive.

## Decision

Remove React from both clients. Replace it with:

1. **`signal<T>()`** — a ~30-line reactive primitive in `@pinpoint/shared`
   (`shared/src/signal.ts`) providing `get()`, `set()`, and `subscribe()`.
   Subscriptions fire immediately with the current value, then on every change.
   `Object.is` equality check prevents redundant updates.

2. **Dashboard** — `<template>` blocks in `dashboard/index.html` cloned via
   `cloneTemplate()`, bound to signals, routed by the History API
   (`dashboard/src/lib/router.ts`).

3. **Extension** — Custom Elements (`<fl-*>`) with Shadow DOM, adopting a
   single constructable stylesheet from `@pinpoint/shared/theme`.

No virtual DOM, no JSX, no build-time transforms beyond standard TypeScript
compilation.

## Consequences

### Positive

- **Smaller bundles** — extension content script dropped from ~80 kB to ~18 kB
  (gzipped).
- **Native Shadow DOM** — Custom Elements work naturally; no synthetic event
  workarounds.
- **Fewer dependencies** — removed `react`, `react-dom`, `react-router-dom`,
  `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`.
- **Simpler mental model** — new contributors learn one 30-line primitive
  instead of hooks, effects, and reconciliation rules.
- **No framework lock-in** — signals are a pattern, not a library.

### Negative

- **No ecosystem** — no off-the-shelf component libraries. All UI is bespoke.
- **Manual DOM updates** — developers must explicitly subscribe and update DOM
  nodes; no automatic diffing.
- **Accessibility burden** — must implement ARIA patterns manually instead of
  relying on community-maintained React components.
- **Hiring signal** — candidates familiar with React may need onboarding time
  to the vanilla approach.
