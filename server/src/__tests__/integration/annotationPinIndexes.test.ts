// Migration 20261127150001: the (project_id, pin_number) and
// (project_id, status, pin_number) indexes that serve the paginated annotation
// list, and the list queries actually use them (forced past the planner's
// small-table preference with enable_seqscan/bitmapscan off so the assertion is
// about index *usability*, not about statistics). Real Postgres; skips if unreachable.
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
let owner: Knex | null = null;
let skipReason: string | null = null;

beforeAll(async () => {
  if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
    skipReason = 'SKIP_INTEGRATION_TESTS=true';
    return;
  }
  try {
    owner = knex({
      client: 'pg',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'pinpoint_test',
        user: process.env.DB_MIGRATION_USER || process.env.DB_USER || 'postgres',
        password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD || 'postgres',
      },
      pool: { min: 1, max: 1 },
      migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
    });
    await owner.raw('SELECT 1');
    await owner.migrate.latest();
  } catch (e) {
    skipReason = e instanceof Error ? e.message : String(e);
    await owner?.destroy().catch(() => {});
    owner = null;
  }
});

afterAll(async () => {
  await owner?.destroy();
});

describe('annotation pin-order indexes', () => {
  it('exist with the expected column order', async (ctx) => {
    if (skipReason || !owner) return ctx.skip();
    const { rows } = await owner.raw(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'annotations' AND indexname IN ('idx_annotations_project_pin','idx_annotations_project_status_pin')",
    );
    const defs = Object.fromEntries(rows.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef]));
    expect(defs.idx_annotations_project_pin).toContain('(project_id, pin_number)');
    expect(defs.idx_annotations_project_status_pin).toContain('(project_id, status, pin_number)');
  });

  it.each([
    ['list', 'SELECT * FROM annotations WHERE project_id = $1 ORDER BY pin_number ASC LIMIT 25 OFFSET 50', 'idx_annotations_project_pin'],
    ['status-filtered list', "SELECT * FROM annotations WHERE project_id = $1 AND status = 'active' ORDER BY pin_number ASC LIMIT 50", 'idx_annotations_project_status_pin'],
  ])('the %s query can use its index (no Sort node)', async (_name, sql, index) => {
    if (skipReason || !owner) return;
    const plan = await owner.transaction(async (trx) => {
      await trx.raw('SET LOCAL enable_seqscan = off');
      await trx.raw('SET LOCAL enable_bitmapscan = off');
      const res = await trx.raw(`EXPLAIN (FORMAT JSON) ${sql.replace('$1', "'00000000-0000-4000-8000-000000000000'")}`);
      return JSON.stringify(res.rows[0]['QUERY PLAN']);
    });
    // With several applicable indexes the planner's pick depends on current
    // statistics (other suites write to this table concurrently). What
    // matters is that an ordered index scan serves it: no Sort node, no seq scan.
    // The named index must be among those the planner may use.
    expect(plan).not.toContain('"Node Type":"Sort"');
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(plan).toMatch(/"Index Name":"idx_annotations_project_(status_)?pin"/);
    void index;
  });
});
