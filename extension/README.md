# `@pinpoint/extension`

The Pinpoint Chrome Extension — Manifest V3, Web Components, no React.

This package replaces the prior React-based content script with native
browser primitives:

- One Custom Element per UI piece: `<fl-overlay-host>` (the root),
  `<fl-popover>`, `<fl-floating-toolbar>`, `<fl-sidebar-panel>`,
  `<fl-annotation-pin>`, `<fl-mention-autocomplete>`, `<fl-comment-thread>`.
- Each element renders into its own Shadow Root and adopts the shared
  constructable stylesheet exported from `@pinpoint/shared/theme`, so
  the palette never drifts between elements.
- The content script (`src/content.ts`) creates the Shadow Root, attaches
  `<fl-overlay-host>`, and lets the host element bootstrap itself.
- A single `PinPositioner` (`src/lib/PinPositioner.ts`) coalesces
  `MutationObserver`, `ResizeObserver`, scroll, and resize signals through
  one `requestAnimationFrame` tick to keep pins glued to their resolved
  DOM targets via `transform: translate3d(...)`.
- State lives in `signal<T>()` slices (from `@pinpoint/shared`) on the
  overlay store; child elements subscribe via property assignment.

There are no React dependencies — `react`, `react-dom`, `@types/react`,
`@types/react-dom`, and `@vitejs/plugin-react` were removed from
`package.json` as part of the post-React migration (Requirement 31.2).

## Authentication

The Extension cannot share cookies with arbitrary host pages, so it uses a
bearer JWT instead of the dashboard's cookie+CSRF flow:

- The same `POST /api/v1/auth/login` response that sets cookies for the
  dashboard also returns `{ token }` in the body.
- The in-extension **popup login** (`popup/popup.ts`) posts the
  credentials, stores the token in `chrome.storage.local`
  (`pinpoint_auth_token`), and then asks the service worker to open the
  overlay on the active tab.
- `src/lib/api.ts` reads the token from `chrome.storage.local` and
  attaches `Authorization: Bearer <token>` on every request, with
  sliding-window refresh via `POST /api/v1/auth/refresh` when the token is
  within five minutes of expiry.
- `API_BASE = '/api/v1'` is the single source of truth for the API path
  prefix.
- Bearer-authenticated requests are CSRF-exempt — the bearer is itself
  proof of possession.

> **Decision (Nov 2026): the token stays in `chrome.storage.local`.** Only the
> extension's own pages and service worker read it (content scripts go through the
> service-worker relay), it is never exposed to web pages, the server caps every
> session at 30 days, and `token_version` revocation logs a device out instantly.
> `storage.session` would force a fresh sign-in after every browser restart for
> little extra protection against an attacker who already controls the local profile.

## Networking: the content-script → service-worker API relay

A content script runs in the **host page's network origin**, so a direct
`fetch()` to the Pinpoint API is an ordinary cross-origin request and is
rejected by the host page's CORS policy on every site except the dashboard
origin. The MV3-correct fix (`src/lib/apiRelay.ts`) relays every API call
to the background service worker, which performs the `fetch` under the
extension's host permissions (not subject to the page's CORS) and returns a
serialised response:

- `isContentScriptContext()` detects when code runs in a content script (a
  `chrome.runtime.id` is present AND the page is not a `chrome-extension:`
  page). Only then does `api.ts` route through the relay; the popup,
  options page, and service worker keep their direct `fetch`.
- `relayFetch(path, init)` serialises the request (a `FormData` screenshot
  body is flattened to base64 fields), sends `{ type: 'PP_API_FETCH', … }`
  to the worker, and reconstructs a real `Response` so every existing
  caller (`apiFetch`, `apiFetchRaw`, `.ok`/`.status`/`.json()`/`.text()`)
  is unchanged.
- The worker handler (`handleRelayRequest`) resolves the API origin,
  attaches the bearer from storage (unless the caller already set one — so
  refresh runs where the token lives), performs the fetch, and returns
  `{ status, statusText, headers, bodyText, bodyBase64? }`.
- Refresh/401 semantics are preserved: the token logic runs client-side in
  `api.ts`, and a 401 still clears the token and surfaces the sign-in
  prompt exactly as before.
- The connection-monitor heartbeat (`HEAD /health`) and the Socket.IO
  client also honour this model. Socket.IO is forced to
  `transports: ['websocket']` (`upgrade: false`): the server's Socket.IO
  `cors.origin` is pinned to the dashboard origin and rejects the HTTP
  long-polling handshake's `Origin` from any other site, but the WebSocket
  upgrade handshake is not CORS-preflighted, so WebSocket-only connects
  cleanly from any host page without weakening the server's Origin check.

## Server URL (configurable API origin)

The API origin is resolved with this precedence (`src/lib/serverOrigin.ts`):

1. **User setting** — a validated **Server URL** on the options page,
   stored in `chrome.storage.local` under `pinpoint_api_origin`.
2. **Build-time default** — `VITE_PINPOINT_API_ORIGIN`, injected by Vite as
   the compile-time global `__PINPOINT_API_ORIGIN__` (default
   `http://localhost:3001`).
3. **Hard default** — `http://localhost:3001`.

The Server URL field accepts any `https://` origin or loopback
`http://localhost` / `http://127.0.0.1`; plaintext to a remote host is
rejected. Saving a new origin requests the matching host permission via
`chrome.permissions.request` (from the save gesture).

## Permissions & on-demand injection

The extension follows least privilege for host access:

- Install-time `host_permissions` are scoped to local development origins
  only (`http://localhost`, `http://127.0.0.1`), and the static
  `content_scripts` auto-inject only there.
- `optional_host_permissions` (`https://*/*`, `http://*/*`) are **requested
  at runtime, never granted at install**.
- To annotate any other site, the content script is injected **on demand**:
  clicking the toolbar action (or signing in from the popup) grants
  `activeTab` for the current tab, and the service worker's
  `handleActionClick(tabId)` then (a) tries `TOGGLE_OVERLAY`, and (b) if no
  content script is present, `chrome.scripting.executeScript`s the built
  content loader — discovered at runtime from
  `chrome.runtime.getManifest().content_scripts[0].js[0]` because CRXJS
  content-hashes the filename — and retries the toggle.
- `web_accessible_resources` exposes the extension's own JS chunks to
  `*://*/*` so the injected loader's dynamic `import()` of the content
  bundle resolves on any origin. This exposes only the extension's own
  code (standard for CRXJS), not any page data.

## PII Redaction & Opt-Out

Before a screenshot is uploaded, the content script scans the DOM with
`computeRedactionRects()` (`src/lib/redaction.ts`) and ships a list of
device-pixel bounding boxes alongside the PNG. The server Gaussian-blurs
those rects before persisting the image, so sensitive pixels never reach
object storage.

The default predicate (Requirement 45.1) blurs:

- `<input type="password">`
- `<input autocomplete="cc-*">` — every WHATWG credit-card autofill token
  (`cc-number`, `cc-csc`, `cc-exp`, `cc-name`, …)
- any element carrying `data-fl-redact` (explicit opt-in)
- any element whose `aria-label` matches the configured PII regex
  (managed from the extension options page; passed into
  `computeRedactionRects` as `ariaLabelRegex`)

### Opting out with `data-fl-no-redact` (Requirement 45.2)

Site authors who *want* certain pixels captured (e.g. a bug-report
tool's own fake "password" demo, a developer console, a fixture screen)
can suppress redaction for an element or any subtree by adding
`data-fl-no-redact` to the element itself or any ancestor:

```html
<!-- Opt a single input out: -->
<input type="password" data-fl-no-redact />

<!-- Opt an entire subtree out: -->
<section data-fl-no-redact>
  <input type="password" />
  <div aria-label="Credit card number">4242 4242 4242 4242</div>
</section>
```

Behaviour:

- The opt-out walks the element and its ancestors via
  `Element.closest('[data-fl-no-redact]')`. A single attribute on a
  wrapping element opts the whole subtree out — the ergonomic
  affordance the requirement calls for.
- The opt-out does **not** propagate downward from a sibling. An ancestor
  that itself matches the redaction predicate (e.g. carries
  `data-fl-redact`) still blurs even when one of its descendants
  carries `data-fl-no-redact`.
- The attribute value is ignored — presence is sufficient. Use the empty
  attribute (`data-fl-no-redact`) or `data-fl-no-redact="true"`
  interchangeably.
- The hook lives in the extension only; the server never receives rects
  for opted-out elements, so there is no server-side bypass to audit.

Use the opt-out sparingly. The redaction is the user's privacy
guarantee — opting out should be a deliberate decision tied to a
specific element, not a blanket disable on a whole page.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `vite build` via `@crxjs/vite-plugin`. Emits a Web-Store-loadable bundle to `dist/`. Set `VITE_PINPOINT_API_ORIGIN` to bake a non-default API origin into the build. |
| `npm run build:firefox` | Same build into `dist-firefox/` plus a Firefox MV3 manifest transform (see [Firefox](#firefox-mv3)). |
| `npm run dev` | `vite` dev server with content-script HMR. |
| `npm test` | Run the Vitest suite for the extension package (Custom Element + property + relay/serverOrigin + background tests). |

Run from the repo root with `npm run <script> --workspace extension` if you
prefer.

## Loading in Chrome

1. Build with `npm run build --workspace extension`.
2. Open `chrome://extensions/` and toggle **Developer mode** on.
3. Click **Load unpacked** and select the **`extension/dist/`** directory (the
   built `manifest.json` lives there — not `extension/`).

## Firefox (MV3)

```bash
npm run build:firefox --workspace extension   # -> extension/dist-firefox/
```

`build:firefox` runs the same `vite build` into `dist-firefox/` and then
`scripts/firefox-manifest.mjs` rewrites that bundle's manifest. The Chrome
build (`dist/`) is untouched. The transform:

- `background.service_worker` → `background.scripts` (Firefox MV3 event page).
- Adds `browser_specific_settings.gecko` with id `pinpoint@pinpoint.dev` and
  `strict_min_version: "128.0"` (first Firefox with
  `scripting.executeScript({ world: 'MAIN' })`, used by the console bridge),
  plus `data_collection_permissions` (honoured by Firefox 140+).
- Strips the `:*` port wildcard from match patterns (Firefox match patterns
  have no port; `http://localhost/*` matches every port).
- Drops Chrome-only `use_dynamic_url` and the `_*_comment` keys.

Lint (zero errors expected; the remaining warnings are the static
`innerHTML` templates, socket.io's `Function("return this")` fallback, and a
min-version note for `data_collection_permissions`):

```bash
npx --yes web-ext@10.8.0 lint --source-dir extension/dist-firefox
```

### Install (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** and pick `extension/dist-firefox/manifest.json`.
3. Firefox MV3 does **not** grant host permissions at install. Open
   `about:addons` → Pinpoint → **Permissions** and enable "Access your data
   for all sites" (or per-site), otherwise the content script and
   `captureVisibleTab` fail on non-activeTab pages.
4. Temporary add-ons are removed on restart; reload from `about:debugging`.

### Compatibility notes

| Feature | Firefox status |
|---|---|
| `chrome.*` namespace with promises | Supported in MV3 (no `browser.*` shim needed). |
| `scripting.executeScript({ world: 'MAIN' })` | Firefox 128+ (the reason for the min version). |
| `storage.session` | Supported (115+). Like Chrome, not exposed to content scripts unless `setAccessLevel` is called, so draft persistence from the content script degrades to a no-op in both browsers. |
| `tabs.captureVisibleTab` | Supported, but MV3 Firefox accepts only **`activeTab`** (granted by the toolbar click, the popup, or a keyboard shortcut in that tab); unlike Chrome, even a user-granted "all sites" host permission does not substitute. In practice the gesture that opens the overlay grants it; without it the upload toast reads "Could not capture screenshot: Missing activeTab permission" and the annotation itself is still saved. |
| Custom Elements in content scripts | Firefox exposes a `customElements` in content scripts, but elements defined from the sandbox are **never upgraded**. The content script therefore forces `@webcomponents/custom-elements` on Firefox (`lib/forceCustomElementsPolyfill.ts`), mirrors its `window.HTMLElement` onto the sandbox global (`window !== globalThis` there) and relaxes its cross-compartment `prototype instanceof Object` check (`lib/syncPolyfilledGlobals.ts`). Chrome (registry is `null` in the isolated world) is unchanged. |
| `commands` / `_execute_action` | Supported. Remap at `about:addons` → gear → **Manage Extension Shortcuts**. |
| `webNavigation.onHistoryStateUpdated` | Supported. |
| `permissions.request` | Must be called synchronously inside the user-input handler (Firefox rejects it after any `await`); the options page requests first and falls back to `permissions.contains`. |
| Page-compartment objects (`FormData`, `Blob#arrayBuffer()`) | Seen through Xray wrappers from the content script: `FormData#entries()` is not iterable and views over the returned buffer throw on `subarray`/spread, so the relay serialises with `forEach` and copies bytes (`toOwnBytes`). |
| WebDriver / Marionette | `e2e/firefox/run.mjs` drives this bundle in a real Firefox — see [`e2e/firefox/README.md`](../e2e/firefox/README.md). |

### Automated run (real Firefox)

```bash
npm run build:firefox --workspace extension
node e2e/firefox/run.mjs        # one-time tool setup: e2e/firefox/README.md
```

Covers popup sign-in, options Server URL, overlay, the real `Alt+Shift+S`
shortcut, click-to-annotate with Firefox environment + console diagnostics,
screenshot upload, comments with `@mention`, resolve/reopen, sidebar,
next/prev pin, realtime, reload and a clean browser console.

### Manual test checklist

Run against the local stack (`http://localhost:5173`, API `:3001`) in Firefox ≥ 128:

1. Load temp add-on; no errors in `about:debugging` → **Inspect** console.
2. Grant site access (step 3 above). Toolbar icon appears.
3. Popup: sign in with a verified account; popup shows signed-in state.
4. Open a local page (`http://localhost:5173`) — overlay toggles via the toolbar icon and `Alt+Shift+F`.
5. Open an `https://` site, click the icon (activeTab) — overlay injects on demand.
6. Click an element → popover opens; submit a Note; numbered pin appears; reload — pin persists.
7. Add a comment with an `@mention`; resolve and reopen the annotation.
8. Screenshot attach works (captureVisibleTab), image shows in the annotation.
9. Bug-type annotation with severity critical: diagnostics include console errors (console bridge, MAIN world). Trigger `console.error('x')` on the page first.
10. SPA navigation (pushState) updates the pins for the new URL.
11. Shortcuts: `Alt+Shift+S` sidebar, `Alt+Shift+.` / `Alt+Shift+,` next/prev pin.
12. Options page: change Server URL; permission prompt appears; values persist.
13. Realtime: a second browser creates an annotation; the pin appears without reload.
14. Sign out in popup; overlay requests re-auth.

## Release Process

The extension ships through the Chrome Web Store. Releases are cut from
`main` after CI is green, version-stamped in `manifest.json`, and
published as a zipped `dist/` upload through the developer dashboard.

### Versioning — SemVer

The extension follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
with the standard `MAJOR.MINOR.PATCH` shape (e.g. `0.1.0`):

- **MAJOR** — breaking permission changes (new `permissions` or
  `host_permissions` entries that require user re-consent, or removals
  that break installed clients).
- **MINOR** — new features that don't change the permission surface
  (additional commands, new overlay capabilities, new UI surfaces).
- **PATCH** — bug fixes, copy tweaks, and other backwards-compatible
  changes that ship without altering the feature set.

Chrome's manifest accepts up to four dot-separated integers, but project
policy is to always pin a 3-part SemVer in `extension/manifest.json` so
the value lines up with `CHANGELOG.md` and the git tag.

### Release steps

1. **Bump the version in `extension/manifest.json`.** Update the `version`
   field to the new 3-part SemVer (e.g. `0.2.0`) per the SemVer rules
   above. This is the value Chrome displays in the Web Store listing and
   on `chrome://extensions`.
2. **Add a `CHANGELOG.md` entry.** In `extension/CHANGELOG.md`, promote
   the `[Unreleased]` section into a dated entry — `## [X.Y.Z] - YYYY-MM-DD`
   — and list every notable change as bullets under the appropriate
   Keep-a-Changelog heading (Added, Changed, Deprecated, Removed, Fixed,
   Security). Open a fresh `[Unreleased]` block above it for the next
   cycle. The version in this entry MUST match `manifest.json`.
3. **Build the production bundle.** From `extension/`, run `npm run build`.
   The output lands in `extension/dist/` and is what the MV3 loader and
   the Web Store expect.
4. **Zip the build for upload.** Zip the *contents* of `dist/` so the
   manifest sits at the archive root:
   `cd extension/dist && zip -r ../pinpoint-extension-<version>.zip .`.
5. **Upload to the Chrome Web Store.** Sign in to the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open the Pinpoint listing, attach the new zip as the next package
   version, refresh the listing copy and screenshots from
   [`store/`](./store/) if anything changed, then submit for review.
6. **Tag the git release.** Once the upload is accepted, tag the commit
   that produced the bundle:

   ```sh
   git tag extension-v<version>
   git push --tags
   ```

   Use the same `<version>` as `manifest.json` and the `CHANGELOG.md`
   entry.

The root [README's Release Process section](../README.md#release-process)
covers the same ground in more detail and lists the listing-asset bundle
under [`store/`](./store/) (long description, screenshots, privacy
policy, support email) that must stay in lockstep with the changelog
entry.

## Keyboard Shortcuts

The extension ships four default keyboard shortcuts (declared in the
`commands` block of `manifest.json` and dispatched by the service worker
to the active tab's content script):

| Action | Default shortcut |
|---|---|
| Toggle overlay | `Alt+Shift+F` |
| Toggle sidebar | `Alt+Shift+S` |
| Next pin | `Alt+Shift+.` |
| Previous pin | `Alt+Shift+,` |

### Remapping shortcuts

Users can rebind any of these to whatever they prefer (and resolve clashes
with site or OS hotkeys) from Chrome's per-extension shortcut settings page:

```
chrome://extensions/shortcuts
```

`chrome://` URLs can't be opened from a markdown link or from regular page
JavaScript, so paste the address into the Chrome address bar manually.
Other Chromium-based browsers expose the same surface under their own
internal scheme — for example `edge://extensions/shortcuts` (Edge),
`brave://extensions/shortcuts` (Brave), `vivaldi://extensions/shortcuts`
(Vivaldi), and `opera://extensions/shortcuts` (Opera). Firefox users can
remap WebExtension commands at `about:addons` → ⚙️ → **Manage Extension
Shortcuts**.

## Where things live

```
src/
├── background.ts         # service worker
├── content.ts            # creates the Shadow Root, mounts <fl-overlay-host>
├── components/           # one Custom Element module per UI piece
├── lib/
│   ├── api.ts            # API_BASE='/api/v1', bearer JWT from chrome.storage
│   ├── PinPositioner.ts  # rAF-coalesced pin transforms
│   ├── DOMTargetResolver.ts
│   ├── mentionFilter.ts
│   └── ...               # collaboration client, stores, etc.
├── styles/               # constructable stylesheet plumbing
└── __tests__/            # property tests (mention filter, DOM round-trip)
```
