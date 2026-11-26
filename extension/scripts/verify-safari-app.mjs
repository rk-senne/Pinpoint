#!/usr/bin/env node
/**
 * Asserts the unsigned Safari app produced by `npm run build:safari-app`
 * contains a web extension bundle (.appex) with the files Safari needs.
 *
 *   node scripts/verify-safari-app.mjs [derivedDataDir]
 *
 * derivedDataDir defaults to $PINPOINT_SAFARI_DD or <tmpdir>/pinpoint-safari-dd
 * (same default as safari-app.mjs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REQUIRED = ['manifest.json', 'background.js', 'content.js'];

export function verify(derived) {
  const app = join(derived, 'Build/Products/Debug/Pinpoint.app');
  const plugins = join(app, 'Contents/PlugIns');
  if (!existsSync(plugins)) throw new Error(`no PlugIns dir in ${app}`);
  const appexes = readdirSync(plugins).filter((n) => n.endsWith('.appex'));
  if (appexes.length === 0) throw new Error(`no .appex in ${plugins}`);
  for (const name of appexes) {
    const res = join(plugins, name, 'Contents/Resources');
    const missing = REQUIRED.filter((f) => !existsSync(join(res, f)));
    if (missing.length) throw new Error(`${name}: missing ${missing.join(', ')} in ${res}`);
    const manifest = JSON.parse(readFileSync(join(res, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3) throw new Error(`${name}: manifest_version ${manifest.manifest_version}, expected 3`);
    console.log(`OK ${name}: ${REQUIRED.join(', ')} present (manifest v${manifest.manifest_version} ${manifest.version})`);
  }
}

verify(process.argv[2] ?? process.env.PINPOINT_SAFARI_DD ?? join(tmpdir(), 'pinpoint-safari-dd'));
