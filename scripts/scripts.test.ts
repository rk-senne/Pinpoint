// Tests for the local demo / maintenance scripts (scripts/*.mts):
//  - the guards in scripts/lib/common.mts (refuse non-local host / unknown DB),
//  - each script's CLI refusing to touch a remote or unknown database,
//  - demo-clean-test-data dry-run is read-only and never matches demo projects,
//  - demo-seed idempotency + --reset against pinpoint_test with an in-process API.
// DB-backed cases skip when no migrated test database is reachable.

import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertLocalDb, dbConfigFromEnv, type DbConfig } from './lib/common.mts';
import { bootLiveApp, type LiveApp } from '../server/src/__tests__/integration/helpers/liveApp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (over: Partial<DbConfig> = {}): DbConfig => ({ host: '127.0.0.1', port: 5432, database: 'pinpoint_test', user: 'u', password: 'p', ...over });

/** Async (never spawnSync): the in-process API must keep serving while the script runs. */
function runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} timed out\n${out}\n${err}`)); }, 100_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('scripts/lib/common.mts — dbConfigFromEnv', () => {
  it('uses documented defaults', () => {
    expect(dbConfigFromEnv({})).toEqual({ host: 'localhost', port: 5432, database: 'pinpoint', user: 'postgres', password: 'postgres' });
  });
  it('prefers the schema-owner DB_MIGRATION_* credentials over the RLS-bound DB_USER', () => {
    const c = dbConfigFromEnv({ DB_USER: 'pinpoint_app', DB_PASSWORD: 'app', DB_MIGRATION_USER: 'owner', DB_MIGRATION_PASSWORD: 'own' });
    expect(c).toMatchObject({ user: 'owner', password: 'own' });
    expect(dbConfigFromEnv({ DB_USER: 'x', DB_PASSWORD: 'y' })).toMatchObject({ user: 'x', password: 'y' });
  });
  it('coerces the port to a number', () => {
    expect(dbConfigFromEnv({ DB_PORT: '5544' }).port).toBe(5544);
  });
});

describe('scripts/lib/common.mts — assertLocalDb guard', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('allows local host %s with a known db', (host) => {
    expect(() => assertLocalDb(cfg({ host }))).not.toThrow();
    expect(() => assertLocalDb(cfg({ host, database: 'pinpoint' }))).not.toThrow();
  });
  it.each(['db.internal', 'prod.example.com', '10.0.0.5', '0.0.0.0', '127.0.0.1.evil.com', 'LOCALHOST', ''])('refuses non-local host %j', (host) => {
    expect(() => assertLocalDb(cfg({ host }))).toThrow(/DB_HOST/);
  });
  it.each(['postgres', 'pinpoint_prod', 'Pinpoint', 'pinpoint ', ''])('refuses unknown database %j', (database) => {
    expect(() => assertLocalDb(cfg({ database }))).toThrow(/DB_NAME/);
  });
  it('can skip only the name check, never the host check', () => {
    expect(() => assertLocalDb(cfg({ database: 'anything' }), { requireKnownName: false })).not.toThrow();
    expect(() => assertLocalDb(cfg({ host: 'prod.example.com', database: 'anything' }), { requireKnownName: false })).toThrow(/DB_HOST/);
  });
});

describe('script CLIs refuse unsafe targets before connecting', () => {
  const base = { DB_PORT: '1', DB_USER: 'x', DB_PASSWORD: 'x' };
  for (const script of ['demo-seed.mts', 'demo-clean-test-data.mts']) {
    it(`${script}: remote DB_HOST → exit 1, no connection attempt`, async () => {
      const r = await runScript(script, [], { ...base, DB_HOST: 'prod-db.example.com', DB_NAME: 'pinpoint' });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Refusing to run: DB_HOST/);
      expect(r.err).not.toMatch(/ECONNREFUSED|ENOTFOUND/);
    });
    it(`${script}: unknown DB_NAME on localhost → exit 1`, async () => {
      const r = await runScript(script, [], { ...base, DB_HOST: '127.0.0.1', DB_NAME: 'customer_data' });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Refusing to run: DB_NAME/);
    });
  }
  it('demo-seed --reset is also guarded (no deletes against a remote host)', async () => {
    const r = await runScript('demo-seed.mts', ['--reset'], { ...base, DB_HOST: 'prod-db.example.com', DB_NAME: 'pinpoint' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Refusing to run/);
  });
});

describe('demo scripts against the real test database', () => {
  let live: LiveApp | null = null;
  let skip: string | null = null;
  let server: Server | null = null;
  let env: Record<string, string> = {};

  beforeAll(async () => {
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    server = await new Promise<Server>((resolve) => { const s = live!.app.listen(0, '127.0.0.1', () => resolve(s)); });
    env = {
      DB_HOST: process.env.DB_HOST ?? '127.0.0.1', DB_PORT: process.env.DB_PORT ?? '5432',
      DB_NAME: process.env.DB_NAME ?? 'pinpoint_test', DB_USER: process.env.DB_USER ?? 'postgres',
      DB_PASSWORD: process.env.DB_PASSWORD ?? 'postgres',
      PINPOINT_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    if (!['127.0.0.1', 'localhost'].includes(env.DB_HOST!) || env.DB_NAME !== 'pinpoint_test') {
      skip = 'DB-backed script tests only run against a local pinpoint_test database';
    }
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await live?.cleanup();
  });

  const demoCounts = async () => {
    const db = live!.db;
    const org = await db('users').where({ email: 'maya.chen@acmestudio.dev' }).first('id');
    const orgId = (await db('memberships').where({ user_id: org.id, role: 'owner' }).first('org_id')).org_id;
    const projects = await db('projects').where({ org_id: orgId }).select('id', 'name').orderBy('name');
    const ids = projects.map((p: { id: string }) => p.id);
    const count = async (t: string, col: string, vals: string[]) => Number((await db(t).whereIn(col, vals).count('* as c').first())!.c);
    return {
      users: Number((await db('users').where('email', 'like', '%@acmestudio.dev').count('* as c').first())!.c),
      projectNames: projects.map((p: { name: string }) => p.name),
      annotations: await count('annotations', 'project_id', ids),
      sharedLinks: await count('shared_links', 'project_id', ids),
      rules: await count('automation_rules', 'org_id', [orgId]),
      sla: await count('sla_policies', 'org_id', [orgId]),
      portals: await count('client_portals', 'org_id', [orgId]),
    };
  };

  it('demo-seed is idempotent: a second run creates nothing new; --reset rebuilds the same shape', async ({ skip: s }) => {
    if (skip) return s(skip);
    const first = await runScript('demo-seed.mts', [], env);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Demo workspace ready/);
    const a = await demoCounts();
    expect(a.users).toBeGreaterThanOrEqual(2);
    expect(a.projectNames).toEqual(expect.arrayContaining(['Acme Marketing Site', 'Northwind Client Portal']));
    expect(a.annotations).toBeGreaterThan(0);

    const second = await runScript('demo-seed.mts', [], env);
    expect(second.err).toBe('');
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already present/);
    expect(await demoCounts()).toEqual(a);

    const reset = await runScript('demo-seed.mts', ['--reset'], env);
    expect(reset.err).toBe('');
    expect(reset.code).toBe(0);
    expect(reset.out).toMatch(/Reset: removed \d+ demo users/);
    expect(await demoCounts()).toEqual(a);
  }, 240_000);

  it('demo-clean-test-data dry-run deletes nothing and never lists demo projects; --yes honours the min-age guard', async ({ skip: s }) => {
    if (skip) return s(skip);
    const before = Number((await live!.db('projects').count('* as c').first())!.c);
    const dry = await runScript('demo-clean-test-data.mts', [], env);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/DRY RUN/);
    expect(dry.out).toMatch(/Nothing deleted/);
    expect(dry.out).not.toMatch(/Acme Marketing Site|Northwind/);
    expect(Number((await live!.db('projects').count('* as c').first())!.c)).toBe(before);

    // A just-created e2e-style project owned by an @example.test user is protected by the 15 min age guard.
    const seeded = await live!.seedOrg(['admin']);
    const admin = seeded.actors.admin!;
    await live!.db('users').where({ id: admin.id }).update({ email: `cleanup-${admin.id}@example.test` });
    const pid = await live!.seedProject(seeded.orgId, admin.id);
    await live!.db('projects').where({ id: pid }).update({ name: `e2e-guard-${pid.slice(0, 6)}` });
    const guarded = await runScript('demo-clean-test-data.mts', ['--yes'], env);
    expect(guarded.code).toBe(0);
    expect(await live!.db('projects').where({ id: pid }).first()).toBeTruthy();

    // Backdated + --yes → deleted; an equally old non-matching name is kept.
    const keepId = await live!.seedProject(seeded.orgId, admin.id);
    await live!.db('projects').whereIn('id', [pid, keepId]).update({ created_at: new Date(Date.now() - 3600_000) });
    await live!.db('projects').where({ id: keepId }).update({ name: 'Customer Website Redesign' });
    const real = await runScript('demo-clean-test-data.mts', ['--yes'], env);
    expect(real.code).toBe(0);
    expect(real.out).toMatch(/Deleted \d+ projects/);
    expect(await live!.db('projects').where({ id: pid }).first()).toBeUndefined();
    expect(await live!.db('projects').where({ id: keepId }).first()).toBeTruthy();
    const demo = await demoCounts();
    expect(demo.projectNames).toContain('Acme Marketing Site');
  }, 240_000);
});
