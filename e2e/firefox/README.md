# Firefox extension harness (`e2e/firefox/run.mjs`)

Drives the **Firefox build** of the extension (`extension/dist-firefox/`) in a
real Firefox over WebDriver (geckodriver + `selenium-webdriver`) against the
local stack, and asserts what the Chrome Playwright spec
(`e2e/browser/extension-ui.spec.ts`) asserts where Firefox allows it.

Playwright cannot load WebExtensions into Firefox, hence a separate,
dependency-free script: `selenium-webdriver` and geckodriver are resolved from
a throwaway tools directory, never from the repo's `package.json`.

## One-time setup

```bash
FX_TOOLS="$HOME/.pinpoint-dev/fxtools"
mkdir -p "$FX_TOOLS" && cd "$FX_TOOLS"
npm init -y >/dev/null
npm i -E selenium-webdriver@4.53.0 geckodriver@8.0.0
# The geckodriver package's postinstall may be blocked; download the binary explicitly:
node --input-type=module -e "import { download } from 'geckodriver'; console.log(await download(undefined, '$FX_TOOLS/bin'))"
```

Firefox: any Firefox ≥ 128 works. By default the harness uses, in order,
`$FIREFOX_BIN`, `$FX_TOOLS/Firefox.app`, then Playwright's cached Firefox
(`npx playwright install firefox`; on macOS
`~/Library/Caches/ms-playwright/firefox-*/firefox/Nightly.app`). geckodriver is
`$GECKODRIVER_BIN` or the newest `$FX_TOOLS/bin/geckodriver-*`.

## Run

Stack up (API on `:3001`), seed session present (`e2e/.auth/seed-session.json`,
written by the Playwright global setup — the harness reuses its bearer token
for API fixtures and signs in through the popup exactly once):

```bash
npm run build:firefox --workspace extension
node e2e/firefox/run.mjs
```

| Variable | Default | Purpose |
|---|---|---|
| `FL_API_URL` | `http://127.0.0.1:3001` | API used for fixtures/assertions (the extension's default origin must match: build with `VITE_PINPOINT_API_ORIGIN` otherwise). |
| `FL_E2E_EMAIL` / `FL_E2E_PASSWORD` | seed account | Popup sign-in. |
| `FX_SITE_PORT` | `5433` | Port of the served landing page (`http://127.0.0.1:<port>/acme-fx-<id>`). |
| `FX_HEADED=1` | headless | Show the browser. |
| `FX_STOP_AFTER=<substr>` | — | Stop after the first step whose name contains `<substr>`. |
| `FX_INSTALL=zip` | directory | Install the zipped bundle instead of the unpacked directory. |
| `FX_KEEP_TMP=1` | — | Keep the temp dir (browser log) even on success. |

Exit code 0 only when every step passed. The temp dir with `firefox.log`
(geckodriver + browser console, `devtools.console.stdout.*` on) is kept on
failure and printed at the end. The project the run creates is deleted again.

## What it covers

1. Temporary add-on install with a fixed moz-extension UUID
   (`extensions.webextensions.uuids`), static host permissions granted.
2. Popup: empty-submit validation, sign-in against the API (CORS through the
   background relay), popup closes itself, signed-in panel shows the account.
3. Options: Server URL rejects `http://evil.example`, saves + normalises an
   `https://` origin (permission request inside the user gesture), restores.
4. Content script on a realistic landing page; overlay via
   `tabs.sendMessage(TOGGLE_OVERLAY)` (what the action handler sends).
5. **Real** `Alt+Shift+S` keyboard shortcut (manifest `commands` →
   background → content) toggles the sidebar; it also grants `activeTab`.
6. Click-to-annotate with a real click (host handler must not fire),
   disclosure, popover anchoring, tabs/severity/body, environment summary
   says Firefox; submit → pin `1`; API row has `browserFamily: "Firefox"`,
   the host page's `console.error` and uncaught error (MAIN-world bridge).
7. Screenshot: `captureVisibleTab` → multipart upload through the relay →
   stored (or a *server* rejection; any client-side failure fails the step).
8. Second annotation, pin view, comment with `@mention` autocomplete (mention
   travels as the user id, no duplicate after the socket echo), resolve/reopen.
9. Sidebar via `FL_COMMAND` + toolbar toggle + close; next/prev pin commands.
10. Realtime: an annotation created through the API appears without reload.
11. Toolbar close restores host-page clicks; reload re-renders all pins.
12. No extension errors in the browser console.

## Harness notes / limits

- WebDriver's `getShadowRoot()` is denied on shadow roots a content script
  created, so DOM state is read with page-world scripts walking
  `element.shadowRoot`; all input is trusted WebDriver pointer/keyboard
  actions at the element's coordinates.
- Browser-level shortcuts are pressed in Marionette's **chrome** context
  (geckodriver `--allow-system-access`), which is what makes them reach
  Firefox's `<key>` handlers. Content-context key actions never trigger
  `commands`.
- The toolbar button / popup panel can't be clicked; the popup and options
  pages are opened as tabs. Consequence: the popup's post-login
  "toggle on the active tab" targets the popup's own tab (a harmless
  `Invalid tab ID` warning, filtered).
- Content scripts of a zip-installed temporary add-on never ran in
  Playwright's Firefox Nightly 150 build; the unpacked-directory install
  (what `web-ext run` does) works, so it is the default.
- Not covered: offline queueing (no WebDriver network emulation in
  Firefox), SPA `pushState` navigation, on-demand injection on a host not in
  `content_scripts`, the clipboard copy-link toast, sign-out.

## CI

`.github/workflows/browsers.yml` (job `firefox-e2e`, ubuntu-24.04) runs this
harness on every PR touching `extension/`, `e2e/firefox/`, `shared/` or
`server/`, and on pushes to `main`. It starts Postgres + the API (same env as
the `e2e` job in `ci.yml`, API as the RLS role `pinpoint_app`), seeds with
`infrastructure/scripts/ci-seed-e2e.sh`, installs `selenium-webdriver@4.53.0`
into `$FX_TOOLS`, downloads the **official** Firefox 161.0 Linux tarball and
geckodriver 0.37.1 (both SHA-256 pinned) and runs
`FX_HEADED=1 xvfb-run node e2e/firefox/run.mjs`. Harness details for CI:

- On Linux the Firefox binary is found at `$FX_TOOLS/firefox/firefox`.
- No Playwright global setup runs there, so the bearer session comes from a
  fresh `POST /auth/login` when `e2e/.auth/seed-session.json` is absent (or its
  token no longer passes `GET /users/me`).
- `FX_LOG_DIR=<dir>` writes `firefox.log` to a fixed directory that is never
  deleted (uploaded as the `firefox-e2e-logs` artifact on failure).
