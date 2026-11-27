// PgAnalyticsRepo.computeForProject is a single SQL GROUP BY (load test,
// docs/PERFORMANCE.md). Pins the bucket semantics against real Postgres as
// pinpoint_app (RLS on): closed-enum counting, unknown browser fallback,
// null / non-object environment => unknown, other projects not counted.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installTenantContext, runAsOrg } from '../../infrastructure/tenantContext.js';
import { PgAnalyticsRepo } from '../../adapters/outbound/postgres/PgAnalyticsRepo.js';

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
const userId = randomUUID();
const projectId = randomUUID();
const otherProjectId = randomUUID();
const pageId = randomUUID();
const otherPageId = randomUUID();

let pin = 0;
function row(project: string, page: string, over: Record<string, unknown>) {
  return {
    project_id: project, org_id: orgId, page_id: page, type: 'note', severity: 'minor', status: 'active',
    body: 'b', author_id: userId, target: JSON.stringify({}), environment: JSON.stringify({ browserFamily: 'Chrome' }),
    pin_number: ++pin, ...over,
  };
}

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
        pool: { min: 1, max: 2 },
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
  await owner('organizations').insert({ id: orgId, name: 'AN', slug: `an-${orgId.slice(0, 8)}` });
  await owner('users').insert({ id: userId, email: `an-${userId}@example.test`, name: 'AN', password_hash: 'x' });
  await owner('projects').insert([
    { id: projectId, name: 'an', urls: [], owner_id: userId, org_id: orgId },
    { id: otherProjectId, name: 'an2', urls: [], owner_id: userId, org_id: orgId },
  ]);
  await owner('pages').insert([
    { id: pageId, project_id: projectId, url: 'https://an.example.test/' },
    { id: otherPageId, project_id: otherProjectId, url: 'https://an.example.test/' },
  ]);
  await owner('annotations').insert([
    row(projectId, pageId, {}),
    row(projectId, pageId, { severity: 'critical', type: 'suggestion', status: 'resolved', environment: JSON.stringify({ browserFamily: 'Safari' }) }),
    row(projectId, pageId, { severity: 'critical', status: 'in_progress', environment: JSON.stringify({ browserFamily: 'Netscape' }) }),
    row(projectId, pageId, { type: 'guideline', environment: null }),
    row(projectId, pageId, { severity: 'major', environment: JSON.stringify('legacy-string') }),
    row(projectId, pageId, { severity: 'informational', environment: JSON.stringify({ browserFamily: 'Chrome' }) }),
    row(otherProjectId, otherPageId, {}),
  ]);
});

afterAll(async () => {
  if (owner) {
    await owner('annotations').whereIn('project_id', [projectId, otherProjectId]).del();
    await owner('pages').whereIn('project_id', [projectId, otherProjectId]).del();
    await owner('projects').whereIn('id', [projectId, otherProjectId]).del();
    await owner('users').where({ id: userId }).del();
    await owner('organizations').where({ id: orgId }).del();
    await owner.destroy();
  }
  await app?.destroy();
});

describe('PgAnalyticsRepo.computeForProject (SQL GROUP BY)', () => {
  it('buckets every dimension and falls back to unknown', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const buckets = await runAsOrg(orgId, () => new PgAnalyticsRepo(app!).computeForProject(projectId));
    expect(buckets.total).toBe(6);
    expect(buckets.bySeverity).toEqual({ critical: 2, major: 1, minor: 2, informational: 1 });
    expect(buckets.byType).toEqual({ note: 4, suggestion: 1, guideline: 1 });
    expect(buckets.byStatus).toEqual({ active: 4, in_progress: 1, resolved: 1 });
    expect(buckets.byBrowser).toMatchObject({ Chrome: 2, Safari: 1, unknown: 3 });
    expect(Object.values(buckets.byBrowser).reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('returns all-zero buckets for a project without annotations', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const buckets = await runAsOrg(orgId, () => new PgAnalyticsRepo(app!).computeForProject(randomUUID()));
    expect(buckets.total).toBe(0);
    expect(Object.values(buckets.byBrowser).every((n) => n === 0)).toBe(true);
  });
});
