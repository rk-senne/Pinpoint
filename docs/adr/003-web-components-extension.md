# ADR-003: Shadow DOM Web Components for the Extension

## Status

Accepted

## Date

2025-05-24

## Context

The Pinpoint Chrome Extension injects UI (annotation pins, toolbar, sidebar,
popovers) onto arbitrary third-party web pages. This creates unique constraints:

- **Style isolation** — the extension UI must not be affected by the host page's
  CSS, and must not leak styles into the host page.
- **DOM isolation** — host-page JavaScript (MutationObservers, frameworks,
  cleanup scripts) should not accidentally destroy or modify extension elements.
- **Event isolation** — click/keyboard handlers on the host page should not
  interfere with extension interactions.
- **Performance** — the content script loads on every page; the UI layer must
  be lightweight.

React's synthetic event system does not propagate correctly across Shadow DOM
boundaries without manual workarounds. Additionally, React's rendering model
assumes ownership of a subtree, which conflicts with injecting into a foreign
document.

## Decision

Build the extension UI entirely from **Custom Elements with Shadow DOM**:

- Each UI piece is a self-contained Custom Element prefixed `<fl-*>`:
  `<fl-overlay-host>`, `<fl-popover>`, `<fl-floating-toolbar>`,
  `<fl-sidebar-panel>`, `<fl-annotation-pin>`, `<fl-mention-autocomplete>`,
  `<fl-comment-thread>`.
- A single `<fl-overlay-host>` element is injected into the host page. It
  creates one Shadow Root (`mode: 'closed'`) that contains all other Pinpoint
  elements.
- All elements adopt a single **constructable stylesheet** exported from
  `@pinpoint/shared/theme`, ensuring consistent theming without `<style>` tag
  duplication.
- Components communicate via:
  - DOM CustomEvents (for parent→child and sibling coordination)
  - Shared signals from `@pinpoint/shared` (for state that spans components)

### No framework in the extension

No React, Lit, Stencil, or other framework. Components are plain classes
extending `HTMLElement` with manual DOM construction in `connectedCallback()`.

## Consequences

### Positive

- **Complete style isolation** — Shadow DOM encapsulation prevents host CSS from
  affecting Pinpoint UI and vice versa.
- **DOM resilience** — host-page scripts cannot querySelector into a closed
  Shadow Root.
- **Zero framework overhead** — no runtime library; just the browser's native
  Custom Elements API.
- **Consistent theming** — one constructable stylesheet adopted by all Shadow
  Roots ensures visual coherence without duplication.
- **Small bundle** — the extension content script is ~18 kB gzipped.

### Negative

- **Verbose boilerplate** — Custom Elements require manual attribute observation,
  lifecycle callbacks, and DOM construction without JSX or templates.
- **No declarative rendering** — updates require imperative DOM manipulation;
  developers must track which elements to update on state change.
- **Browser compatibility** — constructable stylesheets require Chrome 73+
  (acceptable for a Chrome Extension; not an issue).
- **Testing complexity** — testing Custom Elements requires a DOM environment
  (happy-dom or jsdom with custom elements support).
