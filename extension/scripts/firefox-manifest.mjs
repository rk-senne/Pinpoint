#!/usr/bin/env node
/**
 * Post-build step for `npm run build:firefox`.
 *
 * Reads the CRXJS-generated Chrome manifest in `dist-firefox/` (the same
 * bundle `vite build` emits for Chrome, just written to another directory)
 * and rewrites it in place into a Firefox MV3 manifest. The Chrome build
 * (`dist/`) is never touched.
 *
 * Differences applied:
 *  - `background.service_worker` -> `background.scripts` (Firefox MV3 uses
 *    non-persistent event pages; it does not support service workers).
 *  - `browser_specific_settings.gecko` with a stable add-on id and
 *    `strict_min_version` 128.0 (first release supporting
 *    `scripting.executeScript({ world: 'MAIN' })`).
 *  - `use_dynamic_url` (Chrome-only) removed from web_accessible_resources.
 *  - Match patterns lose their `:*` port wildcard (invalid in Firefox).
 *  - Top-level `_*_comment` documentation keys removed (not valid manifest
 *    keys; Chrome tolerates them, Firefox tooling warns).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GECKO_ID = 'pinpoint@pinpoint.dev';
export const GECKO_MIN_VERSION = '128.0';
export const DATA_COLLECTION_REQUIRED = [
  'websiteContent',
  'authenticationInfo',
  'personallyIdentifyingInfo',
  'browsingActivity',
  'websiteActivity',
];

/**
 * Firefox match patterns have no port component: `http://localhost/*`
 * already matches every port, and `localhost:*` is rejected as invalid.
 */
export function stripPort(pattern) {
  return typeof pattern === 'string'
    ? pattern.replace(/^(https?|\*):\/\/([^/:*][^/:]*):(\*|\d+)\//, '$1://$2/')
    : pattern;
}

/** Pure transform: Chrome manifest object -> Firefox manifest object. */
export function toFirefoxManifest(chrome) {
  const out = {};
  for (const [key, value] of Object.entries(chrome)) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }

  const bg = chrome.background ?? {};
  const script = bg.service_worker;
  if (typeof script !== 'string') {
    throw new Error('Chrome manifest has no background.service_worker to convert');
  }
  const { service_worker: _sw, ...bgRest } = bg;
  out.background = { ...bgRest, scripts: [script] };

  if (Array.isArray(chrome.web_accessible_resources)) {
    out.web_accessible_resources = chrome.web_accessible_resources.map((entry) => {
      const { use_dynamic_url: _u, ...rest } = entry;
      return rest;
    });
  }

  if (Array.isArray(out.host_permissions)) {
    out.host_permissions = out.host_permissions.map(stripPort);
  }
  if (Array.isArray(out.content_scripts)) {
    out.content_scripts = out.content_scripts.map((cs) => ({
      ...cs,
      matches: cs.matches?.map(stripPort),
    }));
  }
  if (Array.isArray(out.web_accessible_resources)) {
    out.web_accessible_resources = out.web_accessible_resources.map((entry) => ({
      ...entry,
      matches: entry.matches?.map(stripPort),
    }));
  }

  out.browser_specific_settings = {
    ...(chrome.browser_specific_settings ?? {}),
    gecko: {
      ...(chrome.browser_specific_settings?.gecko ?? {}),
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      // Builtin consent for data sent to the user's configured Pinpoint
      // server. Enforced by Firefox 140+; older versions ignore it. Every
      // category maps to something the extension really transmits (see
      // docs/STORE_SUBMISSION.md, "data_collection_permissions"):
      //   websiteContent        annotation text, screenshots
      //   authenticationInfo    sign-in credentials + bearer token
      //   personallyIdentifyingInfo  sign-in email, @mentioned names
      //   browsingActivity      annotated page URL / route
      //   websiteActivity       session-replay buffer (clicks, scrolls, input)
      // (`technicalAndInteraction` is intentionally absent: Firefox only allows
      // it as an *optional* category, and our browser/OS/viewport + console/
      // network diagnostics are part of the user-submitted report, covered by
      // websiteContent / websiteActivity above.)
      data_collection_permissions: {
        required: DATA_COLLECTION_REQUIRED,
      },
    },
  };
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = resolve(here, '..', process.argv[2] ?? 'dist-firefox', 'manifest.json');
  const chrome = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, `${JSON.stringify(toFirefoxManifest(chrome), null, 2)}\n`);
  console.log(`Wrote Firefox manifest -> ${target}`);
}
