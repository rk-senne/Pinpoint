#!/usr/bin/env node
// Engineering-standards gate (see CONTRIBUTING.md). Plain Node >= 20, no deps.
//
//   node scripts/check-standards.mjs            # all checks
//   node scripts/check-standards.mjs routes     # one check
//
// Checks:
//   deps     every dependency in every package.json is an exact version
//   actions  every `uses:` in .github/workflows is pinned to a 40-char SHA
//   tests    no .only / fixme; a bare .skip needs a `skip-reason:` comment
//   routes   every mounted HTTP route path appears in at least one test
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.STANDARDS_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-firefox', 'dist-safari', '.git', 'coverage', 'artifacts', 'test-results', 'playwright-report', 'build', 'DerivedData']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
const failures = [];
const fail = (check, msg) => failures.push(`[${check}] ${msg}`);

// ---------------------------------------------------------------- deps
function checkDeps() {
  const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  const files = ['package.json', ...readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'package.json')) && !SKIP_DIRS.has(d)).map((d) => `${d}/package.json`)];
  for (const f of files) {
    const pkg = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (EXACT.test(spec) || /^(file|workspace):/.test(spec) || spec === '*') continue;
        fail('deps', `${f} ${field}.${name} = "${spec}" (pin an exact version)`);
      }
    }
  }
}

// ------------------------------------------------------------- actions
function checkActions() {
  const dir = join(ROOT, '.github/workflows');
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) return;
      if (!/@[0-9a-f]{40}$/.test(ref)) fail('actions', `.github/workflows/${name}:${i + 1} ${ref} (pin to a full commit SHA)`);
    });
  }
}

// --------------------------------------------------------------- tests
const TEST_FILE = /\.(test|spec)\.(m?[jt]s|tsx)$|\.setup\.ts$/;
function testFiles() {
  return walk(ROOT).filter((p) => TEST_FILE.test(p));
}
function checkTests() {
  for (const file of testFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `${rel(file)}:${i + 1}`;
      if (/\b(it|test|describe)\.only\s*\(/.test(line)) fail('tests', `${where} .only() would silence the rest of the suite`);
      if (/\btest\.fixme\s*\(/.test(line)) fail('tests', `${where} test.fixme() is not allowed (fix it or skip with a reason)`);
      // Bare skips: it.skip('name', fn) / describe.skip(...) / test.skip('name', fn).
      // Allowed: skipIf(cond), Playwright test.skip(cond, 'reason') / test.skip() inside a test with a reason,
      // or any skip whose line or the line above carries `skip-reason:`.
      const bare = /\b(it|describe)\.skip\s*\(|\btest\.skip\s*\(\s*['"`]/.test(line);
      if (bare) {
        const context = `${lines[i - 1] ?? ''}\n${line}`;
        if (!/skip-reason:/.test(context)) fail('tests', `${where} unconditional skip without a "skip-reason:" comment`);
      }
    });
  }
}

// -------------------------------------------------------------- routes
// Route paths that the detector cannot match textually; each needs a reason.
const ROUTE_EXEMPT = new Map([]);

/** Map routes-file basename -> mount prefixes, from the composition wiring. */
function mountPrefixes() {
  const wiring = ['server/src/adapters/inbound/http/index.ts', 'server/src/composition/container.ts']
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n');
  const httpDir = join(ROOT, 'server/src/adapters/inbound/http');
  const factoryToFile = new Map();
  for (const n of readdirSync(httpDir).filter((x) => /\.routes\.ts$/.test(x))) {
    for (const m of readFileSync(join(httpDir, n), 'utf8').matchAll(/export function (\w+)\s*\(/g)) factoryToFile.set(m[1], n);
  }
  const varToFactory = new Map();
  for (const m of wiring.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(\w+)\s*\(/g)) varToFactory.set(m[1], m[2]);
  // const { aRouter, bRouter } = createX(...)
  for (const m of wiring.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g)) {
    for (const v of m[1].split(',').map((x) => x.split(':').pop().trim()).filter(Boolean)) varToFactory.set(v, m[2]);
  }
  const mounts = new Map();
  const add = (file, prefix, varName) => {
    if (!file) return;
    for (const k of [file, `${file}#${varName}`]) {
      if (!mounts.has(k)) mounts.set(k, new Set());
      mounts.get(k).add(prefix);
    }
  };
  for (const m of wiring.matchAll(/\.use\(\s*(['"`])([^'"`]+)\1\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*(\(|\))/g)) {
    const [, , prefix, name] = m;
    add(factoryToFile.get(name) ?? factoryToFile.get(varToFactory.get(name)), prefix, name);
  }
  return mounts;
}

function checkRoutes() {
  const routeDir = join(ROOT, 'server/src/adapters/inbound/http');
  const routeFiles = readdirSync(routeDir).filter((n) => /\.routes\.ts$/.test(n));
  const corpus = testFiles()
    .filter((p) => /^(server|e2e|mcp-server|scripts)\//.test(rel(p)))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  const mounts = mountPrefixes();
  const PARAM = `(?:[^/'"\`\\s?#]+)`;
  const toRegex = (full) =>
    new RegExp(
      full
        .replace(/\/+$/, '')
        .split('/')
        .map((seg) => (seg.startsWith(':') || seg.includes('${') || seg === '*' ? PARAM : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/') + `(?![\\w-])`,
    );
  let total = 0;
  for (const name of routeFiles) {
    const src = readFileSync(join(routeDir, name), 'utf8');
    for (const m of src.matchAll(/\b(\w*[Rr]outer)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\3/g)) {
      const routerVar = m[1];
      const method = m[2].toUpperCase();
      const path = m[4];
      const prefixes = [...(mounts.get(`${name}#${routerVar}`) ?? mounts.get(name) ?? [])];
      total += 1;
      const key = `${method} ${path}`;
      if (ROUTE_EXEMPT.has(`${name} ${key}`)) continue;
      const candidates = prefixes.map((pre) => (pre.replace(/\/+$/, '') + (path === '/' ? '' : path)) || '/');
      // Route unit tests often mount the router alone; also accept the bare path
      // when it has at least one static segment.
      if (path.split('/').some((seg) => seg && !seg.startsWith(':') && !seg.includes('${'))) candidates.push(path);
      if (candidates.length === 0) {
        fail('routes', `${rel(join(routeDir, name))} ${key}: router is not mounted anywhere the scanner can see`);
        continue;
      }
      if (!candidates.some((c) => toRegex(c).test(corpus))) {
        fail('routes', `${rel(join(routeDir, name))} ${key} (mounted at ${prefixes.join(', ') || '?'}) has no test`);
      }
    }
  }
  if (total < 50) fail('routes', `only ${total} routes detected; the route scanner is probably broken`);
}

const CHECKS = { deps: checkDeps, actions: checkActions, tests: checkTests, routes: checkRoutes };
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
for (const name of selected) {
  if (!CHECKS[name]) {
    console.error(`unknown check: ${name}`);
    process.exit(2);
  }
  CHECKS[name]();
}
if (failures.length) {
  console.error(`Engineering standards: ${failures.length} problem(s)\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Engineering standards: OK (${selected.join(', ')})`);
