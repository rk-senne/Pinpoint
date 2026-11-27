// Integration (real Postgres): routes that write annotations directly (bulk
// actions + the feedback API) must emit the same realtime/webhook domain
// events as the annotation use cases. Skips gracefully when the test DB is
// unreachable (same convention as the other integration suites).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { registerPgTypeParsers } from '../../composition/pgTypes.js';
import { PgAnnotationRepo } from '../../adapters/outbound/postgres/PgAnnotationRepo.js';
import { createBulkRoutes } from '../../adapters/inbound/http/bulk.routes.js';
import { createFeedbackRoutes } from '../../adapters/inbound/http/feedback.routes.js';
import type { DomainEvent, EventBus } from '../../domain/shared/ports/EventBus.js';

registerPgTypeParsers();

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
let db: Knex | null = null;
let skipReason: string | null = null;

const org = randomUUID();
const user = randomUUID();
const member = randomUUID();
const projectId = randomUUID();
const pageId = randomUUID();
const PAGE_URL = 'https://events.test/page';

const TARGET = { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' };
const ENV = { browserFamily: 'Chrome', browserVersion: '1', osFamily: 'macOS', osVersion: '1', deviceType: 'desktop', userAgentRaw: 'ua' };

class RecordingBus implements EventBus {
  events: DomainEvent[] = [];
  emit(event: DomainEvent): void {
    this.events.push(event);
  }
}

describe('Integration: direct-write routes emit domain events (real SQL)', () => {
  let bus: RecordingBus;
  let app: express.Express;

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
    await db('organizations').insert({ id: org, name: `ev-${org}`, slug: `ev-${org}` });
    await db('users').insert([
      { id: user, email: `u-${user}@ev.test`, name: 'u', password_hash: 'x', verified: true },
      { id: member, email: `m-${member}@ev.test`, name: 'm', password_hash: 'x', verified: true },
    ]);
    await db('memberships').insert([
      { org_id: org, user_id: user, role: 'owner' },
      { org_id: org, user_id: member, role: 'member' },
    ]);
    await db('projects').insert({ id: projectId, name: 'P', urls: [PAGE_URL], status: 'active', owner_id: user, org_id: org, pin_counter: 0 });
    await db('pages').insert({ id: pageId, project_id: projectId, url: PAGE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await db('annotations').where({ project_id: projectId }).del();
    await db('pages').where({ id: pageId }).del();
    await db('projects').where({ id: projectId }).del();
    await db('memberships').where({ org_id: org }).del();
    await db('users').whereIn('id', [user, member]).del();
    await db('organizations').where({ id: org }).del();
    await db.destroy();
  });

  beforeEach(() => {
    if (!db) return;
    bus = new RecordingBus();
    const annotationRepo = new PgAnnotationRepo(db);
    const auth: express.RequestHandler = (req, _res, next) => {
      req.user = { userId: user, email: 'u@ev.test', orgId: org, role: 'owner' };
      next();
    };
    app = express();
    app.use(express.json());
    app.use('/api/v1/projects', createBulkRoutes({ authMiddleware: auth, db, annotationRepo, eventBus: bus }));
    app.use('/api/v1/feedback', createFeedbackRoutes({ authMiddleware: auth, db, annotationRepo, eventBus: bus }));
  });

  async function seed(status = 'active'): Promise<string> {
    const [row] = await db!('annotations')
      .insert({
        project_id: projectId, page_id: pageId, org_id: org, author_id: user, type: 'note',
        severity: 'minor', status, body: 'seed', target: JSON.stringify(TARGET),
        environment: JSON.stringify(ENV), pin_number: Math.floor(Math.random() * 1e6),
      })
      .returning('id');
    return (row as { id: string }).id;
  }

  const types = () => bus.events.map((e) => e.type);

  it('bulk resolve emits annotation.status_changed per transitioned annotation only', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed('active');
    const b = await seed('resolved'); // already resolved: no transition
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/annotations/bulk`)
      .send({ ids: [a, b], action: 'resolve' });
    expect(res.status).toBe(200);

    expect(types()).toEqual(['annotation.status_changed']);
    const ev = bus.events[0]!;
    expect(ev.room).toBe(`project:${projectId}`);
    expect(ev.payload).toMatchObject({ id: a, status: 'resolved', previousStatus: 'active', changedBy: user, pageUrl: PAGE_URL });
  });

  it('bulk assign emits annotation.updated for every annotation', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed();
    const b = await seed();
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/annotations/bulk`)
      .send({ ids: [a, b], action: 'assign', params: { assigneeId: member } });
    expect(res.status).toBe(200);

    expect(types()).toEqual(['annotation.updated', 'annotation.updated']);
    expect(bus.events.map((e) => (e.payload as { id: string }).id).sort()).toEqual([a, b].sort());
    expect(bus.events[0]!.payload).toMatchObject({ assigneeId: member, pageUrl: PAGE_URL });
  });

  it('bulk delete emits nothing (no domain event exists for deletes)', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed();
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/annotations/bulk`)
      .send({ ids: [a], action: 'delete' });
    expect(res.status).toBe(200);
    expect(bus.events).toEqual([]);
  });

  it('PATCH /feedback/:id status-only emits annotation.status_changed', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed('active');
    const res = await request(app).patch(`/api/v1/feedback/${a}`).send({ status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(types()).toEqual(['annotation.status_changed']);
    expect(bus.events[0]!.payload).toMatchObject({ id: a, status: 'in_progress', previousStatus: 'active', changedBy: user });
  });

  it('PATCH /feedback/:id with an unchanged status emits no status event', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed('active');
    const res = await request(app).patch(`/api/v1/feedback/${a}`).send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(bus.events).toEqual([]);
  });

  it('PATCH /feedback/:id body-only emits annotation.updated', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed();
    const res = await request(app).patch(`/api/v1/feedback/${a}`).send({ body: 'edited' });
    expect(res.status).toBe(200);
    expect(types()).toEqual(['annotation.updated']);
    expect(bus.events[0]!.payload).toMatchObject({ id: a, body: 'edited', pageUrl: PAGE_URL });
  });

  it('PATCH /feedback/:id with body + status emits both events', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed('active');
    const res = await request(app).patch(`/api/v1/feedback/${a}`).send({ body: 'edited', status: 'resolved' });
    expect(res.status).toBe(200);
    expect(types().sort()).toEqual(['annotation.status_changed', 'annotation.updated']);
  });

  it('POST /feedback emits annotation.created', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await request(app)
      .post('/api/v1/feedback')
      .send({ projectId, body: 'via api', target: TARGET, environment: ENV });
    expect(res.status).toBe(201);
    expect(types()).toEqual(['annotation.created']);
    expect(bus.events[0]!.payload).toMatchObject({ id: res.body.data.id, body: 'via api', pageUrl: PAGE_URL });
  });

  it('a failed validation emits nothing', async (ctx) => {
    if (!db) return ctx.skip();
    const a = await seed();
    const res = await request(app).patch(`/api/v1/feedback/${a}`).send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(bus.events).toEqual([]);
  });

  it('records why the suite was skipped, if it was', () => {
    if (skipReason) console.warn(`directWriteEvents skipped: ${skipReason}`);
    expect(true).toBe(true);
  });
});
