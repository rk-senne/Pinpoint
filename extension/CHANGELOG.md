# Changelog

All notable changes to the Pinpoint browser extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## V2 (Planned)

### Deferred to V2

- Session replay (V2-1) — deferred. Tracked for future release.

## [Unreleased / v0.1.0 - YYYY-MM-DD]

Initial public preview of the Pinpoint extension. Delivered through Phases 14–22 of the implementation plan.

### Added

- Manifest V3 build pipeline using `@crxjs/vite-plugin` and Vite, producing a packaged `extension/dist` artifact.
- Popup login flow that authenticates against the Pinpoint server and persists session state.
- Options page for managing the per-user allow list and block list of origins where the overlay may run.
- Web Components overlay rendered inside a Shadow DOM, compatible with strict Content-Security-Policy hosts.
- Annotation pins anchored to page elements with atomic, project-scoped sequential numbering.
- Comment threads on each pin, including `@mention` support that notifies referenced project members.
- Severity-colored pins backed by a shared theme tokens module, with automatic dark mode support.
- Screenshot capture with an in-overlay markup editor for arrows, boxes, and freehand annotations.
- Console log and network request capture buffers attached to bug reports for richer reproduction context.
- Hover element preview that highlights the DOM target a pin will be anchored to before placement.
- Project picker fallback shown when the active URL does not match any configured project origin.
- Keyboard shortcuts for toggling the overlay, creating pins, and submitting comments.
- Outbox-based offline mode (in progress) that queues mutations locally and replays them when connectivity returns.
- Content-script → service-worker API relay (`lib/apiRelay.ts`): all overlay API calls (including `FormData` screenshot uploads and the connection-monitor heartbeat) are relayed to the service worker, which performs the fetch under the extension's host permissions. This lets the overlay reach the Pinpoint API from any website without the host page's CORS policy blocking it.
- Configurable **Server URL** on the options page (stored in `chrome.storage.local`), plus a build-time default via `VITE_PINPOINT_API_ORIGIN`, so a single installed build can point at a self-hosted or production deployment.
- On-demand content-script injection: on sites not covered by the static (localhost-only) `content_scripts`, clicking the toolbar action grants `activeTab` and the service worker injects the overlay via `chrome.scripting.executeScript`, enabling annotation of any site the user chooses without a blanket install-time host grant.

### Changed

- Socket.IO collaboration client now connects WebSocket-only (`transports: ['websocket']`, `upgrade: false`) so real-time sync works from any host-page origin; the server's polling CORS is pinned to the dashboard origin and would otherwise reject the handshake.
- API-origin resolution moved to `lib/serverOrigin.ts` with precedence user-setting → build-time → `http://localhost:3001` default.

### Deprecated

- _None._

### Removed

- _None._

### Fixed

- _None._

### Security

- Install-time `host_permissions` are scoped to local development origins only; access to any other site is requested at runtime (`optional_host_permissions` + `activeTab` on action click, or a durable grant for the configured Server URL via `chrome.permissions.request`). The new `scripting` permission is used only with that access to inject the overlay on demand.
- The overlay auto-runs only on origins allow-listed by the user via the options page; elsewhere it runs only after the user invokes it.
