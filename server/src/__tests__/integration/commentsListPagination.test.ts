// Regression test (load test, docs/PERFORMANCE.md): GET /annotations/:id/comments
// must read only the requested page. It used to also call `listComments.execute`,
// which loads the WHOLE thread into memory per request (O(thread size)).
// Real Postgres as pinpoint_app; skips when unreachable.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { installTenantContext, runAsOrg } from '../../infrastructure/tenantContext.js';
import { createCommentsRoutes } from '../../adapters/inbound/http/comments.routes.js';
import type { CreateComment } from '../../domain/comment/usecases/createComment.js';
import request from '../supertestClient.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const base = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'pinpoint_test',
};
let owner: Knex | null = null;
let app: Knex | null = null;
let skipReason: string | null = null;
const orgId = randomUUID();
const otherOrgId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();
const pageId = randomUUID();
const annotationId = randomUUID();
const THREAD = 60;

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
        pool: { min: 1, max: 4 },
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
  await owner('organizations').insert([
    { id: orgId, name: 'CL', slug: `cl-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: 'CL2', slug: `cl-${otherOrgId.slice(0, 8)}` },
  ]);
  await owner('users').insert({ id: userId, email: `cl-${userId}@example.test`, name: 'CL', password_hash: 'x' });
  await owner('projects').insert({ id: projectId, name: 'cl', urls: [], owner_id: userId, org_id: orgId });
  await owner('pages').insert({ id: pageId, project_id: projectId, url: 'https://cl.example.test/' });
  await owner('annotations').insert({
    id: annotationId, project_id: projectId, org_id: orgId, page_id: pageId, type: 'note', severity: 'minor',
    status: 'active', body: 'b', author_id: userId, target: JSON.stringify({}), pin_number: 1,
  });
  await owner('comments').insert(
    Array.from({ length: THREAD }, (_, i) => ({
      annotation_id: annotationId, author_id: userId, body: `c${i}`, org_id: orgId,
      created_at: new Date(Date.now() - (THREAD - i) * 1000),
    })),
  );
});

afterAll(async () => {
  if (owner) {
    await owner('comments').where({ annotation_id: annotationId }).del();
    await owner('annotations').where({ id: annotationId }).del();
    await owner('pages').where({ id: pageId }).del();
    await owner('projects').where({ id: projectId }).del();
    await owner('users').where({ id: userId }).del();
    await owner('organizations').whereIn('id', [orgId, otherOrgId]).del();
    await owner.destroy();
  }
  await app?.destroy();
});

function buildApp(db: Knex, actorOrg: string, listSpy: ReturnType<typeof vi.fn>) {
  const server = express();
  server.use(express.json());
  const router = createCommentsRoutes({
    createComment: {} as CreateComment,
    listComments: { execute: listSpy } as never,
    db,
    authMiddleware: (req, _res, next) => {
      (req as express.Request).user = { userId, email: 'x@example.test', orgId: actorOrg, role: 'owner' } as never;
      runAsOrg(actorOrg, next);
    },
  });
  server.use('/annotations/:id/comments', router);
  return server;
}

describe('GET /annotations/:id/comments reads only the requested page', () => {
  it('returns the page + total without loading the whole thread', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const listSpy = vi.fn();
    const res = await request(buildApp(app, orgId, listSpy)).get(`/annotations/${annotationId}/comments?page=2&pageSize=25`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(25);
    expect(res.body.data[0].body).toBe('c25');
    expect(res.body.pagination).toMatchObject({ page: 2, pageSize: 25, total: THREAD });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('is still a 404 for another org (access check unchanged)', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const res = await request(buildApp(app, otherOrgId, vi.fn())).get(`/annotations/${annotationId}/comments`);
    expect(res.status).toBe(404);
  });
});
