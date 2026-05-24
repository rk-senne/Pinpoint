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

### Changed

- _None._

### Deprecated

- _None._

### Removed

- _None._

### Fixed

- _None._

### Security

- Overlay runs only on origins explicitly allow-listed by the user via the options page.
