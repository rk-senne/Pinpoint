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
- `src/lib/api.ts` reads the token from `chrome.storage.local`
  (`pinpoint_auth_token`) and attaches `Authorization: Bearer <token>`
  on every request.
- `API_BASE = '/api/v1'` is the single source of truth for the API path
  prefix.
- Bearer-authenticated requests are CSRF-exempt — the bearer is itself
  proof of possession.

The in-extension popup login surface and sliding-window refresh
(`POST /api/v1/auth/refresh`) land in Phase 15.

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
| `npm run build` | `tsc --build` for now; will become `vite build` once Phase 14's `@crxjs/vite-plugin` lands. Outputs to `dist/`. |
| `npm test` | Run the Vitest suite for the extension package (Custom Element + property tests). |

Run from the repo root with `npm run <script> --workspace extension` if you
prefer. There is no `dev` script today; once CRXJS lands the dev flow
becomes `npm run dev --workspace extension` with content-script HMR.

## Loading in Chrome

1. Build with `npm run build --workspace extension`.
2. Open `chrome://extensions/` and toggle **Developer mode** on.
3. Click **Load unpacked** and select the `extension/` directory (the
   `manifest.json` lives there and references `dist/...` for scripts).

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
4. **Zip the build for upload.** From the repo root, run
   `zip -r pinpoint-extension-<version>.zip extension/dist` (or
   `cd extension/dist && zip -r ../pinpoint-extension-<version>.zip .`
   if you prefer the manifest at the archive root — the dashboard accepts
   either, but be consistent).
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
| Next pin | `Alt+]` |
| Previous pin | `Alt+[` |

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
