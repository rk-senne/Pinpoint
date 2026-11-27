// Integration (real Postgres): org-scoped custom guidelines + `date` round trip.
// Skips gracefully when the test DB is unreachable (same convention as the
// other integration suites).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { registerPgTypeParsers } from '../../composition/pgTypes.js';
import { createGuidelinesRoutes } from '../../adapters/inbound/http/guidelines.routes.js';
import { PgGuidelineRepo } from '../../adapters/outbound/postgres/PgGuidelineRepo.js';
import { PgAnnotationRepo } from '../../adapters/outbound/postgres/PgAnnotationRepo.js';
import { ListGuidelines } from '../../domain/guideline/usecases/listGuidelines.js';
import { CreateCustomGuideline } from '../../domain/guideline/usecases/createCustomGuideline.js';

registerPgTypeParsers();

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
let db: Knex | null = null;
let skipReason: string | null = null;

const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const projectId = randomUUID();
const pageId = randomUUID();
const defaultName = `Default ${randomUUID()}`;

const TARGET = { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' };
const ENV = { browserFamily: 'Chrome', browserVersion: '1', osFamily: 'macOS', osVersion: '1', deviceType: 'desktop', userAgentRaw: 'ua' };

describe('Integration: org-scoped guidelines + date handling (real SQL)', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
      skipReason = 'SKIP_INTEGRATION_TESTS=true';
      return;
    }
    try {
      db = knex({
        client: 'pg',
        connection: {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME || 'pinpoint_test',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
        },
        pool: { min: 1, max: 4 },
        migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
      });
      await db.raw('SELECT 1');
      await db.migrate.latest();
    } catch (e) {
      skipReason = e instanceof Error ? e.message : String(e);
      if (db) await db.destroy().catch(() => {});
      db = null;
      return;
    }
    await db('organizations').insert([
      { id: orgA, name: `g-a-${orgA}`, slug: `g-a-${orgA}` },
      { id: orgB, name: `g-b-${orgB}`, slug: `g-b-${orgB}` },
    ]);
    await db('users').insert([
      { id: userA, email: `a-${userA}@g.test`, name: 'a', password_hash: 'x', verified: true },
      { id: userB, email: `b-${userB}@g.test`, name: 'b', password_hash: 'x', verified: true },
    ]);
    await db('projects').insert({ id: projectId, name: 'P', urls: ['https://a.test'], status: 'active', owner_id: userA, org_id: orgA, pin_counter: 0 });
    await db('pages').insert({ id: pageId, project_id: projectId, url: 'https://a.test/' });
    await db('guidelines').insert({ name: defaultName, description: 'd', is_default: true });
  });

  afterAll(async () => {
    if (!db) return;
    await db('annotations').where({ project_id: projectId }).del();
    await db('guidelines').where({ name: defaultName }).del();
    await db('guidelines').whereIn('org_id', [orgA, orgB]).del();
    await db('pages').where({ id: pageId }).del();
    await db('projects').where({ id: projectId }).del();
    await db('users').whereIn('id', [userA, userB]).del();
    await db('organizations').whereIn('id', [orgA, orgB]).del();
    await db.destroy();
  });

  function guidelinesApp(): express.Express {
    const repo = new PgGuidelineRepo(db!);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/guidelines',
      createGuidelinesRoutes({
        listGuidelines: new ListGuidelines({ guidelineRepo: repo }),
        createCustomGuideline: new CreateCustomGuideline({ guidelineRepo: repo }),
        authMiddleware: (req, res, next) => {
          const who = req.headers['x-as'];
          if (who !== 'A' && who !== 'B') {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'no' } });
            return;
          }
          (req as any).user = {
            userId: who === 'A' ? userA : userB,
            email: 'x@y.z',
            orgId: who === 'A' ? orgA : orgB,
            role: 'owner',
          };
          next();
        },
      }),
    );
    return app;
  }

  it('custom guidelines are visible only to their org; defaults are global', async (ctx) => {
    if (!db) return ctx.skip(`Postgres test DB unavailable: ${skipReason}`);
    const app = guidelinesApp();
    const secret = `Org A secret ${randomUUID()}`;

    const created = await request(app).post('/api/v1/guidelines').set('x-as', 'A').send({ name: secret, description: 'x' });
    expect(created.status).toBe(201);
    const row = await db('guidelines').where({ name: secret }).first();
    expect(row.org_id).toBe(orgA);
    expect(row.is_default).toBe(false);

    const names = async (who: 'A' | 'B') =>
      ((await request(app).get('/api/v1/guidelines?pageSize=100').set('x-as', who)).body.data as Array<{ name: string }>).map((g) => g.name);

    const a = await names('A');
    const b = await names('B');
    expect(a).toContain(secret);
    expect(b).not.toContain(secret);
    expect(a).toContain(defaultName);
    expect(b).toContain(defaultName);
    // The unauthenticated caller gets nothing at all.
    expect((await request(app).get('/api/v1/guidelines')).status).toBe(401);
  });

  it('the DB refuses a custom guideline with no org', async (ctx) => {
    if (!db) return ctx.skip(`Postgres test DB unavailable: ${skipReason}`);
    await expect(
      db('guidelines').insert({ name: 'orphan', description: 'd', is_default: false }),
    ).rejects.toThrow(/guidelines_custom_requires_org/);
  });

  it('a `date` column round-trips as the same YYYY-MM-DD in any server timezone', async (ctx) => {
    if (!db) return ctx.skip(`Postgres test DB unavailable: ${skipReason}`);
    const prevTz = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland'; // far east of UTC: the old toISOString() bug shifted a day back
    try {
      const repo = new PgAnnotationRepo(db);
      const created = await repo.insert({
        projectId, pageId, orgId: orgA, type: 'note', severity: 'minor', status: 'active', body: 'due',
        authorId: userA, target: TARGET, environment: ENV, pinNumber: 1, dueDate: '2026-12-24',
      } as never);
      expect(created.dueDate).toBe('2026-12-24');
      expect((await repo.findById(created.id))!.dueDate).toBe('2026-12-24');
      const updated = await repo.update(created.id, { dueDate: '2027-01-01' });
      expect(updated.dueDate).toBe('2027-01-01');
      expect((await repo.listByProject(projectId))[0]!.dueDate).toBe('2027-01-01');
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
});
