# Store submission guide — Firefox (AMO) and Safari (App Store)

The Chrome Web Store flow is in the root [`README.md`](../README.md#release-process).
This guide covers the two other stores. Shared listing assets live in
[`extension/store/`](../extension/store/) (short/long description, privacy
policy, 1280×800 screenshots, icon, support email).

All commands run from the repository root. Versions are taken from
`extension/manifest.json` (3-part SemVer, same value for every store).

---

## 1. Firefox — addons.mozilla.org (AMO)

### 1.1 Build the submission artifacts

```bash
npm run package:firefox          # = npm run package:firefox --workspace extension
```

Produces (both git-ignored via `extension/.gitignore`):

| File | What it is |
|---|---|
| `extension/artifacts/pinpoint-firefox-<version>.zip` | The add-on: `web-ext@10.8.0 build` of `extension/dist-firefox/`. |
| `extension/artifacts/pinpoint-source-<version>.zip` | Source archive for AMO's reviewers (every tracked/non-ignored repo file + `SOURCE_BUILD.md` at the root). Needed because the bundle is minified. |

`extension/SOURCE_BUILD.md` is the reviewer-facing build recipe (Node ≥ 20,
`npm ci`, `npm run build --workspace @pinpoint/shared`,
`npm run build:firefox --workspace extension`, output `extension/dist-firefox/`).

**Reproducibility (verified).** The source archive was unzipped in `/tmp`,
built from scratch (`npm ci`, shared build, `build:firefox`) and compared with
`diff -r`: `dist-firefox/` was byte-identical to the working tree build, and the
unzipped add-on was byte-identical to it too. Only the zip container differs
run-to-run (web-ext stores file mtimes), so compare extracted files, not zips.
Re-check before every release:

```bash
rm -rf /tmp/pp-src && mkdir /tmp/pp-src && cd /tmp/pp-src
unzip -q <repo>/extension/artifacts/pinpoint-source-<version>.zip
npm ci && npm run build --workspace @pinpoint/shared && npm run build:firefox --workspace extension
diff -r extension/dist-firefox <(unzipped add-on dir)   # no output = identical
```

### 1.2 Lint

```bash
npx --yes web-ext@10.8.0 lint --source-dir extension/dist-firefox
```

Current result: **0 errors, 0 notices, 13 warnings** (was 14: socket.io's
`Function("return this")` is now rewritten to `globalThis` by a build plugin in
`extension/vite.config.ts`). The remaining warnings are expected; say so in the
reviewer notes (§1.6):

| Warning | Count | Why it stays |
|---|---|---|
| `UNSAFE_VAR_ASSIGNMENT` (innerHTML) | 11 | Web Components build their `<template>` content from static string literals + our own CSS constants (`t.innerHTML = \`<style>${CSS}</style>…\``). No page, user, or API data is ever interpolated; user text is only ever written via `textContent`/`setText`. `src/__tests__/cspAudit.test.ts` guards the no-`eval`/no-remote-code rules. |
| `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` | 1 | `strict_min_version` is 128 (ESR) but `data_collection_permissions` is only honoured from 140. Older Firefox ignores the key; raising the minimum to 140 would drop ESR 128 users for no functional gain. |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 1 | Same, for Android (142). The extension is desktop-oriented (keyboard shortcuts, overlay); no `gecko_android` section is declared. |

### 1.3 Browsers verified

`node e2e/firefox/run.mjs` (real Firefox driven through geckodriver, temporary
add-on install, 20 steps: popup login, options, overlay, shortcuts, annotate,
screenshot pipeline, comments with @mention, resolve/reopen, realtime, reload)
passes **20/20** on:

| Firefox | Result |
|---|---|
| 161.0 (release) | 20/20 |
| 140.9.1 ESR | 20/20 |
| 128.14.0 ESR | 20/20 — justifies `strict_min_version: "128.0"` |

`strict_min_version` 128 is the floor because `scripting.executeScript({ world:
'MAIN' })` (console/error bridge) first shipped there; 115 ESR is not
supported. ESR 153.8.0 was not run separately (140 and 161 bracket it).

### 1.4 `data_collection_permissions` (matches what we send)

AMO requires the built-in data-collection declaration. `scripts/firefox-manifest.mjs`
emits `required: [...]` below; each entry maps to data the extension really
transmits **to the user's own configured Pinpoint server only**:

| Category | What is sent | Source |
|---|---|---|
| `websiteContent` | Annotation/comment text, optional viewport screenshot | popover submit, `/annotations`, screenshot upload |
| `authenticationInfo` | Sign-in password (popup → `/auth/login`) and the bearer token on every call | `popup/popup.ts`, `lib/apiRelay.ts` |
| `personallyIdentifyingInfo` | Account email entered at sign-in; @mentioned teammates | popup, comment thread |
| `browsingActivity` | URL/route of the annotated page, resolved DOM selector | annotation create, `lib/pageUrl.ts` |
| `websiteActivity` | The redacted 10-second session-replay buffer (clicks, scroll, input events) attached to a submitted annotation | `lib/sessionReplay.ts`, `content.ts` |

Deliberately **not** listed: `technicalAndInteraction`. Firefox only permits it
as an *optional* category, and our browser/OS/viewport metadata plus
console/network summaries are part of the report the user chooses to submit
(covered by `websiteContent`/`websiteActivity`). If AMO review asks for it, move
it to `optional: ['technicalAndInteraction']` — no code gating exists for it, so
only do that together with a `permissions.contains({ data_collection: [...] })`
check. Nothing is sent to Mozilla, analytics, or any third party; no category is
`none`.

The privacy policy ([`extension/store/privacy-policy.md`](../extension/store/privacy-policy.md))
lists the same items, including the session replay.

### 1.5 Listing text (paste into the AMO developer hub)

**Name:** Pinpoint — Website Feedback

**Summary (≤ 250 chars):**
> Annotate live websites with your team. Pin bugs and feedback to any element, attach screenshots, console logs and browser details, and resolve threads together.

**Categories:** Web Development; Productivity.

**Description:** reuse [`extension/store/description-long.md`](../extension/store/description-long.md)
(AMO renders a subset of Markdown/HTML; strip the leading `#` heading). Short
form for the "Summary" field is in `extension/store/description-short.txt` (132
chars) if you prefer it.

**Support email:** `extension/store/support-email.txt`. **Support site:** the
repository / `https://pinpoint.example` (replace with the production origin).

**Privacy policy:** AMO wants a URL or pasted text. Publish
`extension/store/privacy-policy.md` (rendered) at a stable URL, or paste its
content into the "Privacy policy" field.

**License:** choose one in the AMO form (AMO requires a license choice; match the root `LICENSE` file).

**Screenshots:** `extension/store/screenshots/*.png` (1280×800).

**Per-permission justification** (AMO shows these to users; paste into the
reviewer notes too):

| Permission | Why |
|---|---|
| `activeTab` | Granted by the toolbar click / popup / keyboard shortcut for one tab; lets the overlay be injected and `tabs.captureVisibleTab` take the screenshot the user attaches. No standing access to other sites. (Firefox MV3 `captureVisibleTab` accepts only `activeTab`, not a host grant.) |
| `scripting` | With `activeTab`: inject the overlay content script on demand, and install the page console/error forwarder in the page's MAIN world when the user enables diagnostics. |
| `storage` | Auth token, configured Server URL, per-host capture preferences, offline outbox, drafts — all local. |
| `tabs` | Resolve the active tab's URL (annotation ↔ page mapping), message the content script on shortcut/command, and capture the visible tab. |
| `webNavigation` | `onHistoryStateUpdated` so pins re-anchor after SPA route changes. |
| Host permissions `http://localhost/*`, `http://127.0.0.1/*` (install time) | The content script auto-runs only on local dev origins. |
| Optional host permissions `https://*/*`, `http://*/*` | Never requested at install. Requested at runtime (one browser prompt) only for the user's configured Server URL, or per tab via `activeTab`. |
| Content script `all_frames` on localhost | Dev-origin pages often embed the app in iframes. |

### 1.6 Notes to reviewer (paste into "Notes for reviewers")

> Source: upload `pinpoint-source-<version>.zip`; build steps in its root
> `SOURCE_BUILD.md` (Node 20+, `npm ci`, shared build, `npm run build:firefox
> --workspace extension`, output `extension/dist-firefox/`, identical to the
> submitted add-on). Code is bundled/minified by Vite; no remote code, no
> `eval`/`new Function`, no third-party analytics. The 11 `innerHTML` lint
> warnings are assignments of static template literals (our own CSS + markup,
> never page/user/API data). The only network destination is the user's own
> Pinpoint server (Server URL option; default `http://localhost:3001`), reached
> from the background script. Testing: the extension needs a Pinpoint server;
> run `docker compose up` per the README, register at http://localhost:4173,
> sign in from the toolbar popup, open any page on http://localhost, press
> Alt+Shift+F, click an element, submit. A demo account (maya.chen@acmestudio.dev)
> is created by `npm run demo:seed`.

### 1.7 Submit

**Manual upload (recommended for the first listing):**

1. Sign in at <https://addons.mozilla.org/developers/>.
2. *Submit a New Add-on* → **On this site** (listed) → upload
   `pinpoint-firefox-<version>.zip`; AMO re-runs the linter.
3. When asked "Do you need to submit source code?" answer **Yes** and upload
   `pinpoint-source-<version>.zip`.
4. Fill the listing from §1.5, paste §1.6, upload screenshots, submit.
5. Updates: *Upload a New Version* on the same page; bump `extension/manifest.json`
   first (AMO rejects a repeated version).

**Scripted signing/submission with `web-ext`:**

```bash
export WEB_EXT_API_KEY=user:12345:67      # AMO JWT issuer  (Developer Hub → Tools → Manage API Keys)
export WEB_EXT_API_SECRET=<jwt-secret>    # AMO JWT secret
npx --yes web-ext@10.8.0 sign \
  --source-dir extension/dist-firefox \
  --channel=listed \
  --amo-metadata=amo-metadata.json \                    # listing JSON; needed for the first listed upload
  --upload-source-code=extension/artifacts/pinpoint-source-<version>.zip
```

- `--channel=listed` submits to the public listing (human review; nothing is
  returned until approved). `--channel=unlisted` self-distributes: AMO signs
  the XPI automatically and `web-ext` downloads it to `web-ext-artifacts/`.
- The first listed version needs metadata (name, summary, categories,
  license, privacy policy…) via `--amo-metadata`; create the add-on in the
  Developer Hub once manually, then use `sign` for later versions.
- `amo-metadata.json` follows AMO's [version-create API](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create)
  body (e.g. `{"version":{"license":"<slug>"},"name":{"en-US":"Pinpoint — Website Feedback"},"summary":{"en-US":"…"},"categories":{"firefox":["…"]}}`);
  it is not committed because the license and category slugs are your call.
- Keep the API key/secret in CI secrets, never in the repo. Run
  `npx web-ext@10.8.0 sign --help` to confirm flags for the pinned version.

---

## 2. Safari — Mac App Store

Safari extensions ship inside a macOS app. The repo contains a generated and
committed Xcode project at `extension/safari/Pinpoint/` (bundle ids
`dev.pinpoint.safari` for the app, `dev.pinpoint.safari.Extension` for the
extension; deployment target macOS 13.3, Safari 16.4+).

### 2.1 Build

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # never xcode-select -s / sudo
npm run build:safari --workspace extension        # -> extension/dist-safari/
npm run build:safari-app --workspace extension    # + sync Resources + UNSIGNED xcodebuild
```

`build:safari` = normal CRXJS build, then two classic-IIFE rebundles
(`vite.safari-scripts.config.ts` → `background.js`, `content.js`), then
`scripts/safari-manifest.mjs`, which rewrites the manifest and prunes unused
chunks. Why a separate pass: Safari flags `background.type` / `persistent` as
unsupported and content scripts cannot reliably `import()` web-accessible
chunks, so Safari gets self-contained scripts. Differences from Chrome:

- `background` → `{ scripts: ['background.js'] }`; `content_scripts[0].js` →
  `['content.js']` (the on-demand injector reads this at runtime, so it works
  unchanged); `web_accessible_resources` dropped (nothing needs it).
- `options_page` → `options_ui: { page }` (`open_in_tab` is unsupported).
- Port wildcards stripped from match patterns; `_*_comment` keys removed;
  `browser_specific_settings.safari.strict_min_version` = 16.4 (first Safari
  with `storage.session`).

`xcrun safari-web-extension-converter dist-safari` reports **no unsupported
keys** for the result. Unsigned build verified: `xcodebuild … CODE_SIGN_IDENTITY=-
CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build` → **BUILD SUCCEEDED**
(Xcode 16.4); the `.appex` embeds `manifest.json`, `background.js`, `content.js`.

Regenerating the project (only needed for a new platform/major Xcode):

```bash
xcrun safari-web-extension-converter extension/dist-safari --project-location extension/safari \
  --app-name Pinpoint --bundle-identifier dev.pinpoint.safari --swift --macos-only \
  --copy-resources --no-open --no-prompt
```

The converter ignores `--bundle-identifier` for the target ids (it emits
`dev.pinpoint.Pinpoint…`); after regenerating, replace those with
`dev.pinpoint.safari`, `.safari.Extension`, `.safari.Tests`, `.safari.UITests`
in `project.pbxproj` and `ViewController.swift`, and set the deployment targets
to 13.3. `Pinpoint Extension/Resources/` is a git-ignored copy of
`dist-safari/` made by `npm run safari:sync`.

### 2.2 Static compatibility review

| Area | Finding |
|---|---|
| `storage.session` | Safari 16.4+. `lib/draftStore.ts` already treats a missing/throwing area as "no drafts". |
| `scripting.executeScript({ world: 'MAIN' })` | Used only by the console/error bridge; Safari support for the `world` option on `executeScript` is not guaranteed on 16.4 — the call is wrapped, failure returns `{ ok: false }` and diagnostics simply stay off. |
| `tabs.captureVisibleTab` | Needs a host grant/`activeTab`; failures are caught in the background and surfaced as a toast while the annotation still saves (same path as Firefox). |
| `commands` | Declared normally; the background guards `chrome.commands?.onCommand`. Safari lets users change shortcuts in Safari ▸ Settings ▸ Extensions. |
| `webNavigation` | Guarded (`chrome.webNavigation?.…`); the content script's own history patch is the fallback. |
| `action.openPopup` | Feature-detected before use. |
| Host access | Safari asks the user per site (Settings ▸ Extensions ▸ Pinpoint ▸ Edit Websites…); the manifest's `optional_host_permissions` + `permissions.request` flow still applies. |
| Dynamic `import()` in content scripts | Eliminated (single IIFE). |

**Not verified:** actual behaviour inside Safari. `safaridriver` needs `sudo` to
enable and was deliberately not touched; run the manual test below.

### 2.3 Manual test (Safari ≥ 16.4)

1. `npm run build:safari-app --workspace extension` (or open
   `extension/safari/Pinpoint/Pinpoint.xcodeproj` in Xcode and run).
2. Safari ▸ Settings ▸ Advanced ▸ tick **Show features for web developers**.
3. Safari ▸ **Develop ▸ Allow Unsigned Extensions** (re-enable after each Safari
   restart; asks for your login password).
4. Launch the built `Pinpoint.app` once (it registers the extension), then
   Safari ▸ Settings ▸ **Extensions** ▸ tick **Pinpoint** and set *Allow* for
   `localhost` (and the Server URL host).
5. Start the stack (`docker compose up`), click the Pinpoint toolbar button,
   sign in, open `http://localhost:4173`, press `⌥⇧F`, click an element,
   submit — check the pin, comment thread, `⌥⇧S` sidebar, and reload persistence.
6. Debug: Develop ▸ Web Extension Background Content ▸ Pinpoint (background
   console) and the page's Web Inspector (content script).

### 2.4 Distribution (Apple Developer Program required — US$99/yr)

1. Enrol at <https://developer.apple.com/programs/>; in App Store Connect create
   the app record with bundle id `dev.pinpoint.safari` (register both ids —
   `dev.pinpoint.safari` and `dev.pinpoint.safari.Extension` — under
   *Certificates, Identifiers & Profiles*, with an App Group only if you add one).
2. In Xcode set **Signing & Capabilities → Team** for the `Pinpoint` and
   `Pinpoint Extension` targets (automatic signing). Remove the placeholder
   `PinpointTests`/`PinpointUITests` targets from the scheme if you don't want
   them signed.
3. Fill version/build (`MARKETING_VERSION` = `extension/manifest.json` version,
   bump `CURRENT_PROJECT_VERSION` per upload), category *Developer Tools* or
   *Productivity*, a 1024×1024 app icon (the generated asset catalog uses the
   extension icon — replace with a proper one), privacy details (same data list
   as §1.4), privacy-policy URL and support URL.
4. `Product ▸ Archive` (or `xcodebuild -scheme Pinpoint -configuration Release
   archive -archivePath build/Pinpoint.xcarchive`), then **Distribute App ▸
   App Store Connect ▸ Upload**. Screenshots (Mac: 1280×800 or larger) and
   review notes (same as §1.6) are entered in App Store Connect; submit for review.
5. **Outside the App Store** (direct download): archive → *Distribute App ▸
   Direct Distribution* (Developer ID signing), upload for notarization
   (`xcrun notarytool submit Pinpoint.zip --keychain-profile <profile> --wait`),
   `xcrun stapler staple Pinpoint.app`, then ship the notarized app.
6. iOS/iPadOS Safari is not generated (`--macos-only`). To add it, rerun the
   converter without `--macos-only` into a scratch directory and merge the iOS
   targets.
