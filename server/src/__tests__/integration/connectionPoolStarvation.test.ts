// Regression test (found by the load test, docs/PERFORMANCE.md): a use case that
// opens a transaction but runs some of its statements on the POOL instead of the
// transaction holds one connection while waiting for a second one. Once the number
// of concurrent transactions reaches the pool size every connection is held by a
// transaction waiting for another => pool deadlock until the acquire timeout
// (observed: 98 % of annotation creates failing at 60 concurrent users).
//
// The pool here is deliberately tiny (max 3) and acquisition fails fast, so the
// pre-fix code fails this test within ~2 s. Skips when Postgres is unreachable
// (same convention as the other integration tests).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installTenantContext, runAsOrg } from '../../infrastructure/tenantContext.js';
import { CreateAnnotation, CreateGuestAnnotation } from '../../domain/annotation/usecases/createAnnotation.js';
import { CreateProject } from '../../domain/project/usecases/createProject.js';
import { PgAnnotationRepo } from '../../adapters/outbound/postgres/PgAnnotationRepo.js';
import { PgPageRepo } from '../../adapters/outbound/postgres/PgPageRepo.js';
import { PgProjectRepo } from '../../adapters/outbound/postgres/PgProjectRepo.js';
import { PgProjectPinSequence } from '../../adapters/outbound/postgres/PgProjectPinSequence.js';
import { PgTeamMemberRepo } from '../../adapters/outbound/postgres/PgTeamMemberRepo.js';
import { SystemClock } from '../../adapters/outbound/clock/SystemClock.js';
import { FakeEventBus } from '../fakes/FakeEventBus.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const base = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'pinpoint_test',
};
const POOL_MAX = 3;
const CONCURRENCY = 12; // 4x the pool

let owner: Knex | null = null;
let app: Knex | null = null;
let skipReason: string | null = null;
const orgId = randomUUID();
const userId = randomUUID();
let projectId = '';

function wire(db: Knex) {
  const deps = {
    annotationRepo: new PgAnnotationRepo(db),
    projectRepo: new PgProjectRepo(db),
    pageRepo: new PgPageRepo(db),
    teamMemberRepo: new PgTeamMemberRepo(db),
    pinSequence: new PgProjectPinSequence(db),
    runInTransaction: <T>(fn: (tx: unknown) => Promise<T>) => db.transaction((trx) => fn(trx)),
    clock: new SystemClock(),
    eventBus: new FakeEventBus(),
  };
  return deps;
}

const environment = {
  browserFamily: 'Chrome' as const,
  browserVersion: '120',
  osFamily: 'macOS' as const,
  osVersion: '14',
  deviceType: 'desktop' as const,
  userAgentRaw: 'vitest',
};
const target = { cssSelector: 'body', xpath: '/html/body', pageX: 1, pageY: 2, tagName: 'BODY', textSnippet: 't' };

beforeAll(async () => {
  if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
    skipReason = 'SKIP_INTEGRATION_TESTS=true';
    return;
  }
  try {
    owner = knex({
      client: 'pg',
      connection: {
        ...base,
        user: process.env.DB_MIGRATION_USER || process.env.DB_USER || 'postgres',
        password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD || 'postgres',
      },
      pool: { min: 1, max: 2 },
      migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
    });
    await owner.raw('SELECT 1');
    await owner.migrate.latest();
    app = installTenantContext(
      knex({
        client: 'pg',
        connection: {
          ...base,
          user: process.env.DB_APP_USER || 'pinpoint_app',
          password: process.env.DB_APP_PASSWORD || 'pinpoint-app-local',
        },
        pool: { min: 1, max: POOL_MAX },
        acquireConnectionTimeout: 2_000,
      }),
    );
    await app.raw('SELECT 1');
  } catch (e) {
    skipReason = e instanceof Error ? e.message : String(e);
    await owner?.destroy().catch(() => {});
    await app?.destroy().catch(() => {});
    owner = null;
    app = null;
    return;
  }
  projectId = randomUUID();
  await owner('organizations').insert({ id: orgId, name: 'Pool', slug: `pool-${orgId.slice(0, 8)}` });
  await owner('users').insert({ id: userId, email: `pool-${userId}@example.test`, name: 'Pool', password_hash: 'x' });
  await owner('projects').insert({ id: projectId, name: 'pool', urls: [], owner_id: userId, org_id: orgId });
});

afterAll(async () => {
  if (owner) {
    await owner('annotations').where({ project_id: projectId }).del();
    await owner('pages').where({ project_id: projectId }).del();
    await owner('projects').where({ org_id: orgId }).del();
    await owner('users').where({ id: userId }).del();
    await owner('organizations').where({ id: orgId }).del();
    await owner.destroy();
  }
  await app?.destroy();
});

describe('transactions never need a second pooled connection', () => {
  it(`CreateAnnotation: ${CONCURRENCY} concurrent creates on a pool of ${POOL_MAX} all succeed with unique pins`, async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const create = new CreateAnnotation(wire(app));
    const results = await runAsOrg(orgId, () =>
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          create.execute({
            projectId,
            authorUserId: userId,
            orgId,
            pageUrl: `https://pool.example.test/p${i % 3}`,
            type: 'note',
            severity: 'minor',
            body: `pool ${i}`,
            target,
            environment,
          }),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const pins = results.map((r) => (r.ok ? r.value.annotation.pinNumber : -1));
    expect(new Set(pins).size).toBe(CONCURRENCY);
  });

  it('CreateGuestAnnotation (widget path) is starvation-free too', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const create = new CreateGuestAnnotation(wire(app));
    const results = await runAsOrg(orgId, () =>
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          create.execute({
            projectId,
            orgId,
            pageUrl: 'https://pool.example.test/widget',
            type: 'note',
            severity: 'minor',
            body: `guest ${i}`,
            target,
            environment,
            guest: { name: null, email: null },
          }),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('CreateProject inserts the project and its pages on its own transaction', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const db = app;
    const deps = wire(db);
    const createProject = new CreateProject({
      projectRepo: deps.projectRepo,
      pageRepo: deps.pageRepo,
      runInTransaction: deps.runInTransaction,
    });
    const results = await runAsOrg(orgId, () =>
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          createProject.execute({ ownerUserId: userId, orgId, name: `pool-proj-${i}`, urls: [`https://pool.example.test/proj${i}`] }),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
