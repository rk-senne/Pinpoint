// Tests for scripts/check-standards.mjs against a tiny fixture repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CHECKER = resolve(__dirname, 'check-standards.mjs');
const SHA = 'a'.repeat(40);
let root = '';

function write(path: string, body: string): void {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** A clean fixture: every check passes. Override files to introduce a violation. */
function fixture(overrides: Record<string, string> = {}): void {
  root = mkdtempSync(join(tmpdir(), 'standards-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ devDependencies: { vitest: '4.1.12' } }),
    'server/package.json': JSON.stringify({ dependencies: { express: '5.1.0', '@pinpoint/shared': 'file:../shared' } }),
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v4\n      - uses: ./local-action\n`,
    'server/src/adapters/inbound/http/index.ts':
      "const thingsRouter = createThingRoutes({});\napp.use('/api/v1/things', thingsRouter);\n",
    'server/src/composition/container.ts': '// nothing mounted here\n',
    'server/src/adapters/inbound/http/thing.routes.ts':
      "export function createThingRoutes() {\n  router.get('/', h);\n  router.get('/:id/status', h);\n  return router;\n}\n",
    'server/src/thing.test.ts':
      "it('lists', () => get('/api/v1/things'));\nit('status', () => get(`/api/v1/things/${id}/status`));\n",
  };
  for (let i = 0; i < 50; i++) {
    files['server/src/adapters/inbound/http/thing.routes.ts'] = files['server/src/adapters/inbound/http/thing.routes.ts']!.replace(
      '  return router;',
      `  router.get('/r${i}', h);\n  return router;`,
    );
    files['server/src/thing.test.ts'] += `it('r${i}', () => get('/api/v1/things/r${i}'));\n`;
  }
  for (const [p, b] of Object.entries({ ...files, ...overrides })) write(p, b);
}

function run(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CHECKER], { env: { ...process.env, STANDARDS_ROOT: root }, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('check-standards', () => {
  it('passes a clean repository', () => {
    fixture();
    const r = run();
    expect(r.out).toContain('Engineering standards: OK');
    expect(r.code).toBe(0);
  });

  it('rejects dependency ranges', () => {
    fixture({ 'server/package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }) });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[deps\] server\/package\.json dependencies\.express = "\^5\.1\.0"/);
  });

  it('rejects actions pinned to a tag', () => {
    fixture({ '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n' });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[actions\].*actions\/checkout@v4/);
  });

  it('rejects .only, fixme and unexplained skips but allows conditional skips and skip-reason', () => {
    fixture({
      // Built by concatenation so this file itself passes the check.
      'server/src/a.test.ts': `it${'.'}only('x', () => {});\n`,
      'server/src/b.test.ts': `test${'.'}fixme('y', () => {});\n`,
      'server/src/c.test.ts': `it${'.'}skip('z', () => {});\n`,
      'server/src/ok.test.ts':
        `describe.skipIf(!db)('db', () => {});\ntest.skip(!env, 'needs env');\n// skip-reason: upstream bug #12\nit${'.'}skip('w', () => {});\n`,
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/a\.test\.ts:1 \.only\(\)/);
    expect(r.out).toMatch(/b\.test\.ts:1 test\.fixme\(\)/);
    expect(r.out).toMatch(/c\.test\.ts:1 unconditional skip/);
    expect(r.out).not.toMatch(/ok\.test\.ts/);
  });

  it('reports a route with no test, using the mount prefix', () => {
    fixture();
    write(
      'server/src/adapters/inbound/http/thing.routes.ts',
      "export function createThingRoutes() {\n  router.get('/', h);\n  router.get('/:id/status', h);\n  router.delete('/:id/archive', h);\n" +
        Array.from({ length: 50 }, (_, i) => `  router.get('/r${i}', h);\n`).join('') +
        '  return router;\n}\n',
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[routes\].*DELETE \/:id\/archive \(mounted at \/api\/v1\/things\) has no test/);
    expect(r.out).not.toMatch(/GET \/:id\/status/);
  });
});
