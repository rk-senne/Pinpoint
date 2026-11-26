#!/usr/bin/env node
/**
 * Drives the Firefox build of the Pinpoint extension in a REAL Firefox via
 * WebDriver (geckodriver + selenium-webdriver). See README.md.
 *
 *   node e2e/firefox/run.mjs            # from the repo root
 *   FX_STOP_AFTER=overlay node e2e/firefox/run.mjs   # run steps up to the first matching one
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXT_UUID, GECKO_ID, findFirefox, findGeckodriver, landingPageHtml, loadSelenium,
  poll, resolveSeedSession, sleep, startSite, zipDir,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const E2E = resolve(here, '..');
const API = process.env.FL_API_URL ?? 'http://127.0.0.1:3001';
const PORT = Number(process.env.FX_SITE_PORT ?? 5433);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EXT_BASE = `moz-extension://${EXT_UUID}`;
const SEED_EMAIL = process.env.FL_E2E_EMAIL ?? 'e2e-seed@example.test';
const SEED_PASSWORD = process.env.FL_E2E_PASSWORD ?? 'P@ssw0rd-E2E-1!';
const HEADED = process.env.FX_HEADED === '1';

const { webdriver, firefox } = loadSelenium();
const { Builder, By, Key, until } = webdriver;
const { Command } = loadSelenium().command;

const results = [];
let stopped = false;
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function step(name, fn) {
  if (stopped) return;
  if (process.env.FX_STOP_AFTER && name.includes(process.env.FX_STOP_AFTER)) stopped = true;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  ✗ ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/* ---------------- shadow-piercing helpers ----------------
 * WebDriver's getShadowRoot() cannot enter shadow roots a WebExtension
 * content script created ("Permission denied to access property nodeType"),
 * so the overlay is READ with page-world scripts that walk `el.shadowRoot`,
 * while all INPUT is real, trusted WebDriver actions at the element's
 * viewport coordinates. */
let driver;

/** In-page helpers prepended to every `pageEval` function. */
const DEEP_SRC = `
  // Every element under root, descending into open shadow roots.
  const flat = (root) => {
    const out = [];
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
    if (root.shadowRoot) walk(root.shadowRoot);
    walk(root);
    return out;
  };
  // "a b" = b anywhere below a, across shadow boundaries; "," = union.
  const all = (css, root = document) => {
    const res = new Set();
    for (const sel of css.split(',').map((s) => s.trim()).filter(Boolean)) {
      let scope = [root];
      for (const part of sel.split(" ").filter(Boolean)) {
        const next = new Set();
        for (const s of scope) for (const el of flat(s)) if (el.matches(part)) next.add(el);
        scope = Array.from(next);
      }
      scope.forEach((e) => res.add(e));
    }
    return Array.from(res);
  };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const D = { all, shown, rectOf };
`;

/**
 * Run `fn(D, ...args)` in the host tab (page world, via Marionette). The
 * page world can walk the overlay's open shadow roots; it just can't see the
 * content script's JS properties (none are needed for reading DOM state).
 * Reads never switch tabs, so the host tab stays the active tab — Firefox's
 * `captureVisibleTab` captures the active tab and needs it to be the page.
 */
async function pageEval(fn, ...args) {
  await sw(handles.page);
  return driver.executeScript(`${DEEP_SRC}; return (${fn.toString()})(D, ...arguments);`, ...args);
}

const state = { pageUrl: '' };

/** Wait for a visible (deep) element; returns its viewport rect + text. */
async function waitDeep(css, { timeout = 10_000, visible = true, nth = 0, text } = {}) {
  return poll(async () => {
    const hits = await pageEval((D, css, visible, text) =>
      D.all(css).filter((el) => (!visible || D.shown(el)) && (text == null || (el.textContent || '').includes(text)))
        .map((el) => ({ rect: D.rectOf(el), text: (el.textContent || '').trim() })), css, visible, text);
    return hits[nth] ?? null;
  }, { timeout, what: `element ${css}${text ? ` containing "${text}"` : ''}` });
}
const countDeep = (css, visible = true) =>
  pageEval((D, css, visible) => D.all(css).filter((el) => !visible || D.shown(el)).length, css, visible);
const waitGone = (css, { timeout = 10_000 } = {}) =>
  poll(async () => (await countDeep(css)) === 0, { timeout, what: `${css} to disappear` });

/** Real (trusted) pointer click at the element's centre. */
async function click(css, opts = {}) {
  await sw(handles.page);
  // Wait until the element stops moving (the popover re-positions itself once
  // its content, e.g. a loaded comment thread, changes its height) — a click
  // at a stale position lands on the dialog background instead.
  let hit = await waitDeep(css, opts);
  for (let i = 0; i < 20; i += 1) {
    await sleep(60);
    const again = await waitDeep(css, opts);
    const same = ['x', 'y', 'width', 'height'].every((k) => Math.abs(again.rect[k] - hit.rect[k]) < 0.5);
    hit = again;
    if (same) break;
  }
  const { x, y, width, height } = hit.rect;
  await driver.actions({ async: true }).move({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) }).click().perform();
  return hit;
}
/** Browser-level shortcut (chrome context, so `commands` shortcuts fire). */
async function pressShortcut(mods, key) {
  await sw(handles.page);
  await driver.setContext('chrome');
  try {
    // Under xvfb there is no window manager, so the browser window may never
    // get OS focus and <key> shortcuts would not fire. Focus it explicitly.
    await driver.executeScript(`
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      w.focus();
      w.gBrowser.selectedBrowser.focus();
    `);
    let a = driver.actions({ async: true });
    for (const m of mods) a = a.keyDown(Key[m]);
    a = a.sendKeys(key);
    for (const m of [...mods].reverse()) a = a.keyUp(Key[m]);
    await a.perform();
  } finally {
    await driver.setContext('content');
  }
}

/** Real keyboard input into whatever currently has focus. */
async function type(text) { await sw(handles.page); await driver.actions({ async: true }).sendKeys(text).perform(); }
async function press(key) { await type(key); }

/* ---------------- extension-page helpers ---------------- */
/** Run `fn` (async, string-source) in an extension page (has chrome.*). */
async function inExtPage(fnSource, ...args) {
  return driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1);
     Promise.resolve((${fnSource}).apply(null, args)).then((v) => done({ ok: v }), (e) => done({ err: String(e && e.message || e) }));`,
    ...args,
  ).then((r) => { if (r?.err) throw new Error(r.err); return r?.ok; });
}

/**
 * Install as a temporary add-on. geckodriver's `moz/addon/install` accepts a
 * directory `path` (what `web-ext run` does); selenium's installAddon() only
 * handles zips. Directory install is the default because content scripts of a
 * zip-installed temporary add-on never ran in Playwright's Firefox Nightly
 * build (FX_INSTALL=zip to try the zip path).
 */
async function installTemporaryAddon(path) {
  if (process.env.FX_INSTALL === 'zip') return driver.installAddon(path, true);
  const c = new Command('install addon');
  c.setParameter('path', path);
  c.setParameter('temporary', true);
  return driver.execute(c);
}

const handles = {};
async function openTab(url) {
  await driver.switchTo().newWindow('tab');
  const h = await driver.getWindowHandle();
  await driver.get(url);
  return h;
}
const sw = (h) => driver.switchTo().window(h);

/* ---------------- API helpers ---------------- */
const seed = await resolveSeedSession(E2E, API, SEED_EMAIL, SEED_PASSWORD);
const authHdr = { Authorization: `Bearer ${seed?.body.token ?? ''}`, 'content-type': 'application/json' };
async function api(path, init = {}) {
  let res;
  for (let attempt = 0; ; attempt += 1) {
    res = await fetch(`${API}/api/v1${path}`, { ...init, headers: { ...authHdr, ...(init.headers ?? {}) } });
    // Shared per-IP / per-tenant rate limits: back off instead of failing a step.
    if (res.status !== 429 || attempt >= 3) break;
    await sleep(Math.min(Number(res.headers.get('retry-after') ?? 2), 10) * 1000);
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/* ---------------- main ---------------- */
async function main() {
  // FX_LOG_DIR: fixed, always-kept output dir (CI uploads it as an artifact).
  const tmp = process.env.FX_LOG_DIR ? resolve(process.env.FX_LOG_DIR) : mkdtempSync(join(tmpdir(), 'pp-fx-'));
  mkdirSync(tmp, { recursive: true });
  const logPath = join(tmp, 'firefox.log');
  const logFd = openSync(logPath, 'w');
  // The REAL dist-firefox bundle, unmodified. (Unlike the Chrome spec, no
  // `<all_urls>` copy: Firefox MV3's captureVisibleTab ignores host
  // permissions and needs activeTab, which a real shortcut press grants.)
  const distDir = join(REPO, 'extension/dist-firefox');
  const xpi = join(tmp, 'pinpoint-firefox.zip');
  if (process.env.FX_INSTALL === 'zip') zipDir(distDir, xpi);

  const uniq = Date.now().toString(36);
  const PAGE_URL = `${ORIGIN}/acme-fx-${uniq}`;
  const site = await startSite(PORT, landingPageHtml());
  const projectName = `fx-${uniq}`;
  const created = await api('/projects', { method: 'POST', body: JSON.stringify({ name: projectName, urls: [PAGE_URL] }) });
  const projectId = created.project.id;
  const listAnnotations = async () => (await api(`/projects/${projectId}/annotations?pageSize=100`)).data;

  const options = new firefox.Options().setBinary(findFirefox());
  if (!HEADED) options.addArguments('-headless');
  options
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [GECKO_ID]: EXT_UUID }))
    // Mirror page + extension console output (and JS errors) to stdout -> logPath.
    .setPreference('devtools.console.stdout.content', true)
    .setPreference('devtools.console.stdout.chrome', true)
    // No optional-permission doorhanger (the options step requests https://pinpoint.example.com/*).
    .setPreference('extensions.webextOptionalPermissionPrompts', false)
    .setPreference('datareporting.policy.dataSubmissionEnabled', false);
  const service = new firefox.ServiceBuilder(findGeckodriver())
    // Chrome-context access: used only to press browser-level shortcuts (see pressShortcut).
    .addArguments('--allow-system-access')
    .setStdio(['ignore', logFd, logFd]);
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  const caps = await driver.getCapabilities();
  console.log(`Firefox ${caps.get('browserVersion')} — ${PAGE_URL}`);

  try {
    await driver.manage().setTimeouts({ script: 30_000, pageLoad: 30_000 });
    await driver.manage().window().setRect({ width: 1280, height: 900 });

    await step('install add-on (temporary, host permissions granted)', async () => {
      const id = await installTemporaryAddon(process.env.FX_INSTALL === 'zip' ? xpi : distDir);
      eq(id, GECKO_ID, 'add-on id');
      handles.ext = await openTab(`${EXT_BASE}/options/options.html`);
      const perms = await inExtPage('() => chrome.permissions.getAll()');
      assert(perms.origins.includes('http://127.0.0.1/*'), `127.0.0.1 host permission granted (${JSON.stringify(perms.origins)})`);
    });

    await step('popup: signed-out form, validation, sign in, signed-in panel', async () => {
      // A stable control tab (extension origin => chrome.* available) outlives the popup tab,
      // which closes itself after a successful sign-in (window.close()).
      await sw(handles.ext);
      const popupTab = await openTab(`${EXT_BASE}/popup/popup.html`);
      await driver.wait(until.elementLocated(By.css('#popup-login-form')), 5000);
      await driver.findElement(By.css('#popup-submit')).click();
      eq(await (await driver.findElement(By.css('#popup-error'))).getText(), 'Please enter your email and password.', 'empty-submit message');
      await driver.findElement(By.css('#popup-email')).sendKeys(SEED_EMAIL);
      await driver.findElement(By.css('#popup-password')).sendKeys(SEED_PASSWORD);
      await driver.findElement(By.css('#popup-submit')).click();
      await poll(async () => !(await driver.getAllWindowHandles()).includes(popupTab), { what: 'popup to close itself after sign-in' })
        .catch(async (e) => {
          // Surface the popup's own error (e.g. the 5/min login rate limit when re-running quickly).
          const msg = await driver.findElement(By.css('#popup-error')).getText().catch(() => '');
          throw new Error(`${e.message}; popup error: "${msg}"`);
        });
      await sw(handles.ext);
      assert(await inExtPage(`async () => (await chrome.storage.local.get('pinpoint_auth_token')).pinpoint_auth_token`), 'auth token in storage.local');
      await driver.get(`${EXT_BASE}/popup/popup.html`);
      await poll(async () => (await driver.findElement(By.css('#popup-signed-in')).isDisplayed()), { what: 'signed-in panel' });
      await poll(async () => (await driver.findElement(By.css('#popup-user-email')).getText()) === seed.body.user.email, { what: 'signed-in email' });
    });

    await step('options: Server URL validation + save', async () => {
      await driver.get(`${EXT_BASE}/options/options.html`);
      const server = await driver.findElement(By.css('#server-url'));
      const original = await server.getAttribute('value');
      assert(original, 'server url prefilled');
      const set = async (v) => { await server.clear(); await server.sendKeys(v, Key.TAB); };
      await set('http://evil.example');
      eq(await driver.findElement(By.css('#server-url-status')).getText(), 'Enter an https:// URL or http://localhost.', 'rejects http://evil.example');
      await set('https://pinpoint.example.com/some/path');
      await poll(async () => (await driver.findElement(By.css('#server-url-status')).getText()) === 'Server URL saved.', { what: 'saved status (last: ' + (await driver.findElement(By.css('#server-url-status')).getText()) + ')' });
      eq(await server.getAttribute('value'), 'https://pinpoint.example.com', 'normalised origin');
      await set(original);
      await poll(async () => (await driver.findElement(By.css('#server-url-status')).getText()) === 'Server URL saved.', { what: 'restored status' });
      await poll(async () => (await driver.findElement(By.css('#auth-state')).getText()) === 'You are signed in to Pinpoint.', { what: 'auth-state' });
    });

    await step('content script injects on the host page', async () => {
      handles.page = await openTab(PAGE_URL);
      state.pageUrl = PAGE_URL;
      await driver.wait(until.elementLocated(By.css('#pinpoint-shadow-host')), 10_000);
    });

    const sendToPage = async (message) => {
      await sw(handles.ext);
      await inExtPage(
        `async (u, m) => { const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.startsWith(u)); await chrome.tabs.sendMessage(t.id, m); }`,
        PAGE_URL, message);
      await sw(handles.page);
    };
    const pins = () => pageEval((D) => D.all('fl-annotation-pin').filter((e) => e.style.display !== 'none')
      .map((e) => ((e.shadowRoot && e.shadowRoot.querySelector('.pin-number') || {}).textContent || '').trim()));
    const listAnnotations = async () => (await api(`/projects/${projectId}/annotations?pageSize=100`)).data;
    const waitForAnnotation = (body) => poll(async () => (await listAnnotations()).find((a) => a.body === body), { timeout: 15_000, interval: 1000, what: `annotation "${body}" in API` });
    /** Set a textarea's value with real typing. */
    const typeInto = async (css, text) => { await click(css); await type(text); };

    await step('overlay: TOGGLE_OVERLAY via tabs.sendMessage shows the toolbar', async () => {
      await sendToPage({ type: 'TOGGLE_OVERLAY' });
      await waitDeep('fl-floating-toolbar .fl-toolbar');
      await sleep(800); // project binding (members + annotations)
    });

    await step('real keyboard shortcut Alt+Shift+S (commands API) toggles the sidebar + grants activeTab', async () => {
      // Chrome-context key actions reach Firefox's <key> shortcuts, so this is
      // the REAL `commands` path (manifest suggested_key → background
      // onCommand → FL_COMMAND → content). Like a toolbar click it also grants
      // `activeTab`, which Firefox's captureVisibleTab requires: in MV3 Firefox
      // only accepts the `<all_urls>` API permission (absent in MV3) or activeTab;
      // a granted `<all_urls>` HOST permission is not enough.
      await pressShortcut(['ALT', 'SHIFT'], 's');
      await waitDeep('fl-sidebar-panel .fl-sidebar', { timeout: 5000 });
      await pressShortcut(['ALT', 'SHIFT'], 's');
      await waitGone('fl-sidebar-panel .fl-sidebar', { timeout: 5000 });
    });

    await step('host diagnostics: console.error + uncaught error on the page', async () => {
      await sw(handles.page);
      await driver.executeScript('window.triggerHostError()');
      // Page-owned timer: a Marionette-sandbox setTimeout would not reach the page's `error` listeners.
      await driver.executeScript('window.triggerHostCrash()');
      await sleep(400);
    });

    await step('click-to-annotate: overlay swallows the click, disclosure → popover', async () => {
      await sw(handles.page);
      await driver.findElement(By.css('#cta')).click(); // real click; the overlay must capture it
      await waitDeep('fl-popover fl-disclosure-modal dialog, fl-popover pp-disclosure-modal dialog, fl-disclosure-modal dialog');
      await click('fl-disclosure-modal button, pp-disclosure-modal button', { text: 'Acknowledge' });
      eq(await driver.executeScript('return window.__ctaClicks || 0'), 0, 'host click handler must NOT fire');
      const dlg = await waitDeep('fl-popover dialog.fl-popover');
      const el = await driver.findElement(By.css('#cta')).getRect();
      assert(Math.abs(dlg.rect.x - el.x) < 40, `popover horizontally anchored to the element (dx=${dlg.rect.x - el.x})`);
      assert(!(dlg.rect.y < el.y + el.height && dlg.rect.y + dlg.rect.height > el.y), 'popover must not cover the annotated element');
    });

    await step('popover: tab, severity, body, environment shows Firefox', async () => {
      await click('fl-popover [role=tab][data-tab=suggestion]');
      await waitDeep('fl-popover [role=tab][data-tab=suggestion][aria-selected=true]');
      await click('fl-popover .fl-severity-btn[data-severity=critical]');
      await waitDeep('fl-popover .fl-severity-btn[data-severity=critical][aria-checked=true]');
      await typeInto('fl-popover textarea[part=textarea]', 'Hero CTA contrast fails WCAG AA on the gradient');
      const env = await waitDeep('fl-popover .fl-environment-summary-text');
      assert(env.text.includes('Firefox'), `environment summary mentions Firefox (got "${env.text}")`);
    });

    await step('submit: numbered pin + API row (Firefox env, console bridge diagnostics)', async () => {
      await click('fl-popover button[data-action=submit]');
      await waitGone('fl-popover dialog.fl-popover');
      await poll(async () => (await pins()).join() === '1', { what: 'pin #1 visible', timeout: 10_000 });
      const row = await waitForAnnotation('Hero CTA contrast fails WCAG AA on the gradient');
      eq([row.type, row.severity, row.pinNumber], ['suggestion', 'critical', 1], 'type/severity/pin');
      eq(row.target.cssSelector, '#cta', 'target selector');
      eq(row.target.textSnippet, 'Start free trial', 'text snippet');
      eq(row.environment?.browserFamily, 'Firefox', 'environment.browserFamily');
      assert((row.environment?.userAgentRaw ?? '').includes('Firefox'), 'UA contains Firefox');
      assert(row.consoleLogs?.some((l) => l.message === 'Pricing API failed: GET /api/prices 500'), `consoleLogs captured via MAIN-world bridge (got ${JSON.stringify(row.consoleLogs)})`);
      assert(row.jsErrors?.some((e) => e.kind === 'error' && e.message.includes('Checkout widget crashed')), `jsErrors captured (got ${JSON.stringify(row.jsErrors)})`);
      state.firstId = row.id;
    });

    await step('screenshot pipeline (captureVisibleTab) → uploaded or server-rejected, never client-side failure', async () => {
      const toast = () => pageEval((D) => (D.all('fl-floating-toolbar .fl-toolbar-toast')[0] || {}).textContent || '');
      await poll(async () => {
        const t = await toast();
        if (t.startsWith('Could not upload screenshot: ')) return t;
        const fresh = (await listAnnotations()).find((a) => a.id === state.firstId);
        return fresh?.screenshotObjectKey ? 'stored' : '';
      }, { timeout: 20_000, interval: 2000, what: 'screenshot stored or server-rejected' }).catch(async (e) => {
        throw new Error(`${e.message}; toast="${await toast()}"`);
      });
      const t = await toast();
      state.screenshotToast = t;
      if (t) { assert(!/not found|404|not synced|permission|activeTab|<all_urls>|not iterable|is not a function|undefined|null|TypeError/i.test(t), `client-side screenshot failure: ${t}`); console.log(`      (screenshot: ${t})`); }
      else console.log('      (screenshot stored)');
    });

    await step('more annotations → pins 1,2', async () => {
      await sw(handles.page);
      await driver.findElement(By.css('#buy-pro')).click();
      await waitDeep('fl-popover dialog.fl-popover');
      await click('fl-popover .fl-severity-btn[data-severity=major]');
      await typeInto('fl-popover textarea[part=textarea]', 'Pro CTA label should say "Start Pro trial"');
      const cap = await waitDeep('fl-popover input.fl-popover-capture-checkbox');
      if (await pageEval((D) => D.all('fl-popover input.fl-popover-capture-checkbox')[0].checked)) await click('fl-popover input.fl-popover-capture-checkbox');
      await click('fl-popover button[data-action=submit]');
      await waitGone('fl-popover dialog.fl-popover');
      await poll(async () => (await pins()).join() === '1,2', { what: 'pins 1,2', timeout: 10_000 });
      await waitForAnnotation('Pro CTA label should say "Start Pro trial"');
      await poll(async () => (await countDeep('fl-annotation-pin[data-pending]', false)) === 0, { what: 'no pending pins' });
    });

    await step('pin → view mode, comment thread with @mention autocomplete', async () => {
      const second = (await listAnnotations()).find((a) => a.pinNumber === 2);
      await api(`/annotations/${second.id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Copy team owns this label.' }) });
      await click('fl-annotation-pin', { nth: 1 });
      await waitDeep('fl-popover .fl-popover-view');
      eq((await waitDeep('fl-popover .fl-annotation-body')).text, 'Pro CTA label should say "Start Pro trial"', 'view body');
      await typeInto('fl-popover fl-comment-thread textarea', 'Agreed - @E2');
      const opt = await waitDeep('fl-comment-thread fl-mention-autocomplete li.fl-mention-item').catch(async (e) => {
        const dbg = await pageEval((D) => ({
          value: (D.all('fl-popover fl-comment-thread textarea')[0] || {}).value,
          ac: D.all('fl-comment-thread fl-mention-autocomplete').map((a) => [a.hidden, a.shadowRoot ? a.shadowRoot.querySelectorAll('li').length : -1]),
          active: (() => { let el = document.activeElement; const p = []; while (el) { p.push(el.localName); el = el.shadowRoot && el.shadowRoot.activeElement; } return p.join('>'); })(),
        }));
        throw new Error(`${e.message}; ${JSON.stringify(dbg)}`);
      });
      assert(opt.text.includes(seed.body.user.name), `mention option lists ${seed.body.user.name} (got "${opt.text}")`);
      await press(Key.ENTER);
      await poll(async () => (await pageEval((D) => D.all('fl-popover fl-comment-thread textarea')[0].value)) === `Agreed - @${seed.body.user.name} `, { what: 'mention inserted' });
      await type('can you take this one?');
      await click('fl-popover fl-comment-thread button.fl-btn-primary');
      await poll(async () => (await countDeep('fl-popover fl-comment-thread .fl-comment')) === 2, { what: 'two rendered comments' });
      const comments = (await poll(async () => { const c = (await api(`/annotations/${second.id}/comments`)).data; return c.length === 2 ? c : null; }, { what: 'comment persisted via API', interval: 1000 }));
      eq(comments[1].body, `Agreed - @${seed.body.user.name} can you take this one?`, 'comment body');
      assert(comments[1].mentions.includes(seed.body.user.id), 'mention travels as user id');
      await sleep(1000);
      eq(await countDeep('fl-popover fl-comment-thread .fl-comment'), 2, 'no duplicate after socket echo');
      state.secondId = second.id;
    });

    await step('resolve → reopen round-trips to the API', async () => {
      const status = async () => (await listAnnotations()).find((a) => a.id === state.secondId)?.status;
      await click('fl-popover button[data-action=resolve]');
      await poll(async () => (await status()) === 'resolved', { what: 'resolved in API', interval: 1000 });
      await click('fl-popover button[data-action=reopen]');
      await poll(async () => (await status()) === 'active', { what: 'active in API', interval: 1000 });
      await click('fl-popover button[data-action=close]');
      await waitGone('fl-popover dialog.fl-popover');
    });

    await step('sidebar: FL_COMMAND toggle-sidebar + toolbar toggle', async () => {
      await click('fl-annotation-pin', { nth: 1 });
      await click('fl-popover button[data-action=resolve]');
      await poll(async () => (await listAnnotations()).find((a) => a.id === state.secondId)?.status === 'resolved', { what: 'resolved', interval: 1000 });
      if ((await countDeep('fl-popover dialog.fl-popover')) > 0) { await click('fl-popover button[data-action=close]'); await waitGone('fl-popover dialog.fl-popover'); }
      eq(await countDeep('fl-sidebar-panel .fl-sidebar'), 0, 'sidebar closed by default');
      await sendToPage({ type: 'FL_COMMAND', command: 'toggle-sidebar' });
      await waitDeep('fl-sidebar-panel .fl-sidebar');
      await poll(async () => /Active \(1\)/.test((await waitDeep('fl-sidebar-panel [role=tab][data-tab=active]')).text), { what: 'Active (1)' });
      assert(/Resolved \(1\)/.test((await waitDeep('fl-sidebar-panel [role=tab][data-tab=resolved]')).text), 'Resolved (1)');
      await click('fl-sidebar-panel [role=tab][data-tab=resolved]');
      await poll(async () => (await countDeep('fl-sidebar-panel li.fl-sidebar-item')) === 1, { what: 'one resolved row' });
      await click('fl-sidebar-panel li.fl-sidebar-item');
      eq((await waitDeep('fl-popover .fl-annotation-body')).text, 'Pro CTA label should say "Start Pro trial"', 'row click opens annotation');
      await press(Key.ESCAPE);
      await waitGone('fl-popover dialog.fl-popover');
      await click('fl-floating-toolbar button[data-action=sidebar]');
      await waitGone('fl-sidebar-panel .fl-sidebar');
      await click('fl-floating-toolbar button[data-action=sidebar]');
      await waitDeep('fl-sidebar-panel .fl-sidebar');
      await click('fl-sidebar-panel button.fl-close-btn');
      await waitGone('fl-sidebar-panel .fl-sidebar');
    });

    await step('next / prev pin commands', async () => {
      const body = async () => (await waitDeep('fl-popover .fl-annotation-body')).text;
      await sendToPage({ type: 'FL_COMMAND', command: 'next-pin' });
      eq(await body(), 'Hero CTA contrast fails WCAG AA on the gradient', 'next #1');
      await sendToPage({ type: 'FL_COMMAND', command: 'next-pin' });
      await poll(async () => (await body()) === 'Pro CTA label should say "Start Pro trial"', { what: 'next #2' });
      await sendToPage({ type: 'FL_COMMAND', command: 'prev-pin' });
      await poll(async () => (await body()) === 'Hero CTA contrast fails WCAG AA on the gradient', { what: 'prev #1' });
      await press(Key.ESCAPE);
    });

    await step('realtime: annotation by another client appears without reload (Socket.IO in Firefox)', async () => {
      await api(`/projects/${projectId}/annotations`, {
        method: 'POST',
        body: JSON.stringify({
          pageUrl: PAGE_URL,
          body: 'From a teammate (dashboard)',
          type: 'note',
          severity: 'informational',
          target: { cssSelector: '#footer', xpath: '/html/body/footer', pageX: 48, pageY: 760, tagName: 'FOOTER', textSnippet: '' },
          environment: { browserFamily: 'Chrome', browserVersion: '1', osFamily: 'Linux', osVersion: '1', deviceType: 'desktop', userAgentRaw: 'ua' },
        }),
      });
      await poll(async () => (await pins()).join() === '1,2,3', { what: 'realtime pin #3', timeout: 15_000 });
    });

    await step('toolbar close: overlay hidden, host page clicks work again', async () => {
      await click('fl-floating-toolbar button[data-action=close]');
      await poll(async () => !(await driver.findElement(By.css('#pinpoint-shadow-host')).isDisplayed()), { what: 'overlay hidden' });
      await driver.findElement(By.css('#cta')).click();
      eq(await driver.executeScript('return window.__ctaClicks || 0'), 1, 'host click handler fires once overlay is closed');
    });

    await step('reload: pins persist and re-render from the API', async () => {
      await sw(handles.page);
      await driver.navigate().refresh();
      await driver.wait(until.elementLocated(By.css('#pinpoint-shadow-host')), 10_000);
      // Overlay state is per page load; toggle it back on.
      await sendToPage({ type: 'TOGGLE_OVERLAY' });
      await poll(async () => (await pins()).join() === '1,2,3', { what: 'pins re-rendered after reload', timeout: 15_000 });
    });

    await step('uncaught errors: none from the extension in the browser console', async () => {
      const log = readFileSync(logPath, 'utf8');
      // Firefox-internal noise unrelated to the add-on.
      const noise = [/juggler/i, /services-settings/, /FaviconLoader/, /Unable to find the attachment/, /nsIWebProgress/, /LoginRecipes/, /LoginManagerChild/];
      // Harness artifact: the popup runs in a TAB here, so its post-login
      // "toggle on the active tab" targets its own tab, which then closes.
      const harness = [/on-demand content-script injection failed for tab \d+: Invalid tab ID/];
      const bad = log.split('\n').filter((l) =>
        (/JavaScript error|uncaught|console\.error|TypeError|ReferenceError/.test(l) || /console\.warn: .*\[pinpoint\]/i.test(l)) &&
        (l.includes(EXT_UUID) || /pinpoint/i.test(l)) && ![...noise, ...harness].some((n) => n.test(l)));
      assert(bad.length === 0, `extension console errors:\n        ${bad.slice(0, 8).join('\n        ')}`);
    });

  } finally {
    await driver.quit().catch(() => {});
    site.close();
    await api(`/projects/${projectId}`, { method: 'DELETE', body: JSON.stringify({ confirmationToken: projectName }) }).catch(() => {});
    closeSync(logFd);
    console.log(`log: ${logPath}`);
    if (process.env.FX_KEEP_TMP !== '1' && !process.env.FX_LOG_DIR && results.every((r) => r.ok)) rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
