#!/usr/bin/env node
/**
 * Store packaging for the Firefox (AMO) build.
 *
 *   node scripts/package.mjs firefox   # -> artifacts/pinpoint-firefox-<version>.zip
 *                                      #    artifacts/pinpoint-source-<version>.zip
 *   node scripts/package.mjs source    # source archive only
 *
 * The add-on zip is produced by `web-ext build` (pinned) from `dist-firefox/`,
 * which `npm run package:firefox` rebuilds first. The source archive is what
 * AMO reviewers need to reproduce the minified bundle: every tracked or
 * not-yet-ignored file of the repository (so it also works before the
 * changes are committed), plus SOURCE_BUILD.md at the archive root.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_EXT_VERSION = '10.8.0';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '..');
const repo = resolve(ext, '..');
const artifacts = join(ext, 'artifacts');
const { version } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
}

export function packageFirefox() {
  const dist = join(ext, 'dist-firefox');
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error('dist-firefox/ missing — run `npm run build:firefox --workspace extension` first');
  }
  mkdirSync(artifacts, { recursive: true });
  run('npx', [
    '--yes', `web-ext@${WEB_EXT_VERSION}`, 'build',
    '--source-dir', dist,
    '--artifacts-dir', artifacts,
    '--filename', `pinpoint-firefox-${version}.zip`,
    '--overwrite-dest',
  ], { cwd: ext });
  console.log(`Wrote ${join(artifacts, `pinpoint-firefox-${version}.zip`)}`);
}

export function packageSource() {
  mkdirSync(artifacts, { recursive: true });
  const out = join(artifacts, `pinpoint-source-${version}.zip`);
  rmSync(out, { force: true });
  // Tracked + untracked-but-not-ignored files; drop store artifacts.
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo, maxBuffer: 1 << 28 })
    .toString('utf8').split('\0')
    .filter((f) => f && existsSync(join(repo, f)) && !f.startsWith('extension/artifacts/'))
    .sort();
  // SOURCE_BUILD.md must sit at the archive root for reviewers.
  copyFileSync(join(ext, 'SOURCE_BUILD.md'), join(repo, 'SOURCE_BUILD.md'));
  try {
    run('zip', ['-X', '-q', out, '-@'], { cwd: repo, input: ['SOURCE_BUILD.md', ...files].join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
  } finally {
    rmSync(join(repo, 'SOURCE_BUILD.md'), { force: true });
  }
  console.log(`Wrote ${out} (${files.length + 1} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === 'firefox') { packageFirefox(); packageSource(); }
  else if (target === 'source') packageSource();
  else { console.error('usage: package.mjs firefox|source'); process.exit(2); }
}
