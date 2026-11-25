#!/usr/bin/env node
/**
 * Safari app wrapper (macOS + Xcode only).
 *
 *   node scripts/safari-app.mjs sync    # dist-safari/ -> the Xcode project's extension Resources
 *   node scripts/safari-app.mjs build   # sync, then an UNSIGNED xcodebuild (Debug)
 *
 * Run `npm run build:safari` first (`npm run build:safari-app` does both).
 * The Resources copy is git-ignored build output; the committed Xcode project
 * lists its top-level entries (assets, background.js, content.js, icons,
 * manifest.json, options, popup), which `build:safari` always produces.
 *
 * DEVELOPER_DIR defaults to /Applications/Xcode.app when that exists (we never
 * `xcode-select -s`). Derived data goes to $PINPOINT_SAFARI_DD or the OS tmp dir.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(ext, 'dist-safari');
const project = join(ext, 'safari/Pinpoint/Pinpoint.xcodeproj');
const resources = join(ext, 'safari/Pinpoint/Pinpoint Extension/Resources');

export function sync() {
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error('dist-safari/ missing — run `npm run build:safari --workspace extension` first');
  }
  rmSync(resources, { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  cpSync(dist, resources, { recursive: true });
  console.log(`Synced dist-safari -> ${resources}`);
}

export function build() {
  if (process.platform !== 'darwin') throw new Error('The Safari app can only be built on macOS');
  sync();
  const env = { ...process.env };
  if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app')) {
    env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
  }
  const derived = process.env.PINPOINT_SAFARI_DD ?? join(tmpdir(), 'pinpoint-safari-dd');
  execFileSync('xcodebuild', [
    '-project', project, '-scheme', 'Pinpoint', '-configuration', 'Debug',
    '-derivedDataPath', derived,
    'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGNING_ALLOWED=NO',
    'build',
  ], { stdio: 'inherit', env });
  console.log(`Unsigned app: ${join(derived, 'Build/Products/Debug/Pinpoint.app')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'sync') sync();
  else if (cmd === 'build') build();
  else { console.error('usage: safari-app.mjs sync|build'); process.exit(2); }
}
