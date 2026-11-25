#!/usr/bin/env node
/**
 * Post-build step for `npm run build:safari`.
 *
 * `build:safari` = (1) the normal CRXJS `vite build` into `dist-safari/`
 * (popup, options, icons, hashed chunks), (2) two classic-IIFE re-bundles of
 * the background and content scripts (vite.safari-scripts.config.ts ->
 * `dist-safari/background.js`, `dist-safari/content.js`), (3) this script,
 * which rewrites the Chrome manifest in place into one Safari accepts
 * (`xcrun safari-web-extension-converter` reports no unsupported keys) and
 * prunes the CRXJS module loaders/chunks that are no longer referenced.
 * The Chrome (`dist/`) and Firefox (`dist-firefox/`) builds are never touched.
 *
 * Differences applied:
 *  - `background` -> `{ scripts: ['background.js'] }`: Safari flags
 *    `background.type` and `persistent` as unsupported, so the worker is a
 *    self-contained classic script instead of the CRXJS ES-module loader.
 *  - `content_scripts[0].js` -> `['content.js']` (single classic script; no
 *    runtime `import()` of web-accessible chunks, which Safari content
 *    scripts do not reliably support) and `web_accessible_resources` dropped
 *    (nothing is fetched from the page any more).
 *  - `browser_specific_settings.safari.strict_min_version` 16.4 — the first
 *    Safari with `storage.session` (popover drafts) and MV3 scripting.
 *  - Match patterns lose their `:*` port wildcard (not valid in Safari).
 *  - Top-level `_*_comment` documentation keys removed.
 *  - `options_page` -> `options_ui: { page }` (Safari only implements
 *    `options_ui`; `open_in_tab` is flagged unsupported).
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripPort } from './firefox-manifest.mjs';

export const SAFARI_MIN_VERSION = '16.4';

/** Pure transform: Chrome manifest object -> Safari manifest object. */
export function toSafariManifest(chrome) {
  const out = {};
  for (const [key, value] of Object.entries(chrome)) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }

  if (typeof chrome.background?.service_worker !== 'string') {
    throw new Error('Chrome manifest has no background.service_worker to convert');
  }
  out.background = { scripts: ['background.js'] };

  if (typeof out.options_page === 'string') {
    out.options_ui = { page: out.options_page };
    delete out.options_page;
  }

  const fixMatches = (entry) => (entry.matches ? { ...entry, matches: entry.matches.map(stripPort) } : entry);
  if (Array.isArray(out.host_permissions)) out.host_permissions = out.host_permissions.map(stripPort);
  if (Array.isArray(out.optional_host_permissions)) {
    out.optional_host_permissions = out.optional_host_permissions.map(stripPort);
  }
  if (Array.isArray(out.content_scripts)) {
    out.content_scripts = out.content_scripts.map((cs) => fixMatches({ ...cs, js: ['content.js'] }));
  }
  delete out.web_accessible_resources;

  out.browser_specific_settings = {
    ...(chrome.browser_specific_settings ?? {}),
    safari: { strict_min_version: SAFARI_MIN_VERSION },
  };
  return out;
}

/**
 * Delete the CRXJS module loaders/chunks only the replaced scripts used:
 * every `assets/*.js` that no remaining file mentions by name.
 */
export function pruneOrphans(dir) {
  rmSync(join(dir, 'service-worker-loader.js'), { force: true });
  rmSync(join(dir, 'src'), { recursive: true, force: true });
  for (const f of readdirSync(join(dir, 'assets'))) {
    if (/^(background|content)\.ts-/.test(f)) rmSync(join(dir, 'assets', f));
  }
  const textFiles = () => {
    const out = ['popup/popup.html', 'options/options.html', 'background.js', 'content.js']
      .filter((f) => existsSync(join(dir, f)));
    for (const f of readdirSync(join(dir, 'assets'))) out.push(`assets/${f}`);
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const files = textFiles();
    const text = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    for (const f of files.filter((n) => n.startsWith('assets/'))) {
      const base = f.slice('assets/'.length);
      const used = [...text].some(([other, body]) => other !== f && body.includes(base));
      if (!used) { rmSync(join(dir, f)); changed = true; }
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const dir = resolve(here, '..', process.argv[2] ?? 'dist-safari');
  const target = join(dir, 'manifest.json');
  const chrome = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, `${JSON.stringify(toSafariManifest(chrome), null, 2)}\n`);
  pruneOrphans(dir);
  console.log(`Wrote Safari manifest -> ${target}`);
}
