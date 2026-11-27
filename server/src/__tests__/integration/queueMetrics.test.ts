// Integration test (real Postgres): the operational gauges behind the
// monitoring alerts (pinpoint_db_up, queue depth/age, new failures) are read
// through the UNPRIVILEGED `pinpoint_app` role, exactly like production.
//
// Why it matters: `webhook_deliveries` is tenant-scoped by RLS, so a poll that
// is not in the `system` tenant context silently sees ZERO rows and every
// webhook alert would be blind. The first test pins that behaviour; the second
// proves `startQueueMetrics` (which wraps its queries in runAsSystem) sees them.
// Skips gracefully when Postgres / the pinpoint_app role is unreachable (same
// convention as the other integration tests).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import client from 'prom-client';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installTenantContext, runAsOrg } from '../../infrastructure/tenantContext.js';
import { startQueueMetrics } from '../../infrastructure/metrics.js';

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
const endpointId = randomUUID();
const notifIds = [randomUUID(), randomUUID()];
const deliveryIds = [randomUUID(), randomUUID()];

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
  await owner('organizations').insert({ id: orgId, name: 'QM', slug: `qm-${orgId.slice(0, 8)}` });
  await owner('webhook_endpoints').insert({ id: endpointId, org_id: orgId, url: 'https://hooks.example.test/x', secret: 'whsec_x', events: ['*'], active: true });
  const tenMinAgo = owner.raw("now() - interval '10 minutes'");
  await owner('webhook_deliveries').insert([
    { id: deliveryIds[0], endpoint_id: endpointId, event_type: 'annotation.created', payload: {}, status: 'pending', scheduled_at: tenMinAgo },
    { id: deliveryIds[1], endpoint_id: endpointId, event_type: 'annotation.created', payload: {}, status: 'pending', scheduled_at: tenMinAgo },
  ]);
  await owner('notifications').insert(notifIds.map((id) => ({ id, status: 'pending', payload: {}, scheduled_at: tenMinAgo })));
});

afterAll(async () => {
  if (owner) {
    await owner('webhook_deliveries').where({ endpoint_id: endpointId }).del();
    await owner('webhook_endpoints').where({ id: endpointId }).del();
    await owner('notifications').whereIn('id', notifIds).del();
    await owner('organizations').where({ id: orgId }).del();
    await owner.destroy();
  }
  await app?.destroy();
});

describe('startQueueMetrics against real Postgres as pinpoint_app (RLS on)', () => {
  it('pinpoint_app cannot see webhook_deliveries outside the system context (the reason for runAsSystem)', async (ctx) => {
    if (skipReason || !app) return ctx.skip();
    const other = randomUUID();
    const rows = await runAsOrg(other, () => app!('webhook_deliveries').where({ endpoint_id: endpointId }).count({ n: '*' }).first());
    expect(Number(rows?.n)).toBe(0);
  });

  it('reports the seeded pending depth, age and a NEW failure, and db_up=1', async (ctx) => {
    if (skipReason || !app || !owner) return ctx.skip();
    const registry = new client.Registry();
    const q = startQueueMetrics(registry, { db: app, intervalMs: 3_600_000 });
    await q.collect(); // baseline
    // A delivery turning failed after the baseline is a new failure.
    await owner('webhook_deliveries').where({ id: deliveryIds[0] }).update({ status: 'failed' });
    await owner('webhook_deliveries').insert({ endpoint_id: endpointId, event_type: 'x', payload: {}, status: 'failed' });
    await q.collect();
    const text = await registry.metrics();
    q.stop();
    const val = (name: string): number => Number(new RegExp(`^${name} ([0-9.e+-]+)$`, 'm').exec(text)?.[1] ?? NaN);
    expect(val('pinpoint_db_up')).toBe(1);
    expect(val('pinpoint_webhook_deliveries_pending')).toBeGreaterThanOrEqual(1);
    expect(val('pinpoint_webhook_deliveries_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(590);
    expect(val('pinpoint_webhook_delivery_failures_total')).toBeGreaterThanOrEqual(2);
    expect(val('pinpoint_notifications_pending')).toBeGreaterThanOrEqual(2);
    expect(val('pinpoint_notifications_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(590);
  });
});
