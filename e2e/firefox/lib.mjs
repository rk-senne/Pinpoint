/**
 * Harness helpers for the real-Firefox extension run (see README.md).
 *
 * Not part of the repo's dependency graph on purpose: selenium-webdriver and
 * geckodriver are resolved from a throwaway tools dir (FX_TOOLS, default
 * $HOME/.pinpoint-dev/fxtools) so no new dependency is added to the repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const FX_TOOLS = process.env.FX_TOOLS ?? join(HOME, '.pinpoint-dev', 'fxtools');

/** Fixed add-on UUID so moz-extension://<uuid>/ pages are addressable. */
export const EXT_UUID = '7f6c1f4e-3b0a-4c55-9a52-5a0c0e1f0001';
export const GECKO_ID = 'pinpoint@pinpoint.dev';

export function loadSelenium() {
  const req = createRequire(join(FX_TOOLS, 'package.json'));
  return {
    webdriver: req('selenium-webdriver'),
    firefox: req('selenium-webdriver/firefox'),
    command: req('selenium-webdriver/lib/command'),
  };
}

/** FIREFOX_BIN, else a Firefox.app under FX_TOOLS, else Playwright's cached Firefox (macOS / Linux). */
export function findFirefox() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const candidates = [
    join(FX_TOOLS, 'Firefox.app/Contents/MacOS/firefox'), // macOS release app
    join(FX_TOOLS, 'firefox/firefox'), // Linux official release tarball extracted into FX_TOOLS (CI)
  ];
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(HOME, 'Library/Caches/ms-playwright'), join(HOME, '.cache/ms-playwright')];
  for (const pw of caches.filter((p) => p && existsSync(p))) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith('firefox-')).sort().reverse()) {
      candidates.push(join(pw, d, 'firefox/Nightly.app/Contents/MacOS/firefox')); // macOS
      candidates.push(join(pw, d, 'firefox/firefox')); // Linux
    }
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`No Firefox found. Set FIREFOX_BIN (tried: ${candidates.join(', ')})`);
  return found;
}

/** geckodriver binary: GECKODRIVER_BIN or the newest FX_TOOLS/bin/geckodriver-*. */
export function findGeckodriver() {
  if (process.env.GECKODRIVER_BIN) return process.env.GECKODRIVER_BIN;
  const dir = join(FX_TOOLS, 'bin');
  const hit = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('geckodriver')).sort().pop() : null;
  if (!hit) throw new Error(`geckodriver not found in ${dir}; see e2e/firefox/README.md`);
  return join(dir, hit);
}

export function zipDir(dir, out) {
  execFileSync('rm', ['-f', out]);
  execFileSync('zip', ['-qr', out, '.'], { cwd: dir });
}

export function startSite(port, html) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      r.end(html);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function readSeedSession(e2eDir) {
  try {
    const s = JSON.parse(readFileSync(join(e2eDir, '.auth/seed-session.json'), 'utf8'));
    return s?.body?.token ? s : null;
  } catch {
    return null;
  }
}

/**
 * Bearer session for API fixtures: the Playwright global-setup file when it is
 * still valid, otherwise a fresh login (CI never runs the Playwright setup;
 * locally a stale token is refreshed instead of failing with 401).
 */
export async function resolveSeedSession(e2eDir, api, email, password) {
  const cached = readSeedSession(e2eDir);
  if (cached) {
    try {
      const r = await fetch(`${api}/api/v1/users/me`, { headers: { Authorization: `Bearer ${cached.body.token}` } });
      if (r.ok) return cached;
    } catch { /* fall through to login */ }
  }
  const res = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`seed login failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body?.token) throw new Error('seed login returned no bearer token');
  return { body };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function poll(fn, { timeout = 10_000, interval = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(interval);
  }
}

/** A realistic landing page (header / hero / pricing cards / footer). */
export function landingPageHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme Cloud — Ship faster</title>
<style>
*{box-sizing:border-box} body{margin:0;font-family:Georgia,serif;color:#14213d;background:#fbfaf7}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 48px;background:#14213d;color:#fff}
nav a{color:#fff;margin-left:24px;text-decoration:none;font-family:system-ui,sans-serif}
.hero{padding:72px 48px 56px;text-align:center;background:linear-gradient(180deg,#e9eef8,#fbfaf7)}
.hero h1{font-size:48px;margin:0 0 12px}
.cta{background:#fca311;color:#14213d;border:0;border-radius:10px;padding:14px 28px;font-size:18px;font-weight:700;cursor:pointer}
.pricing{display:flex;gap:24px;justify-content:center;padding:24px 48px 64px;flex-wrap:wrap}
.card{background:#fff;border:1px solid #dfe3ec;border-radius:14px;padding:28px;width:280px}
.card button{width:100%;padding:12px;border-radius:8px;border:1px solid #14213d;background:#fff;font-size:16px;cursor:pointer}
footer{padding:32px 48px;background:#14213d;color:#c9d1e3;font-family:system-ui,sans-serif}
</style></head><body>
<header><span id="logo">Acme Cloud</span><nav><a href="#features" id="nav-features">Features</a><a href="#pricing" id="nav-pricing">Pricing</a></nav></header>
<section class="hero"><h1 id="hero-title">Ship faster with Acme Cloud</h1>
<button class="cta" id="cta" onclick="window.__ctaClicks=(window.__ctaClicks||0)+1">Start free trial</button></section>
<section class="pricing" id="pricing">
<div class="card" id="plan-starter"><h3>Starter</h3><p>$0</p><button id="buy-starter">Choose Starter</button></div>
<div class="card" id="plan-pro"><h3>Pro</h3><p>$29</p><button id="buy-pro">Choose Pro</button></div>
<div class="card" id="plan-team"><h3>Team</h3><p>$99</p><button id="buy-team">Choose Team</button></div></section>
<footer id="footer">© 2026 Acme Cloud, Inc.</footer>
<script>
window.triggerHostError = function () { console.error('Pricing API failed: GET /api/prices 500'); };
window.triggerHostCrash = function () { setTimeout(function () { throw new Error('Checkout widget crashed'); }, 0); };
</script></body></html>`;
}
