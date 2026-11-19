// GAP 6: Heatmap density SQL aggregate — real-Postgres parity with the oracle.
//
// `heatmap.routes.ts` computes density with a Postgres
// `GROUP BY floor((target->>'pageX')::numeric / :cell), floor(...pageY...)`
// aggregate (`buildHeatmapAggregateSql`). The pure `bucketIntoHeatmapCells`
// function in `heatmap.utils.ts` stays the reference oracle. This test runs
// the *actual* SQL against a real Postgres, seeds annotations with a mix of
// valid, missing, and non-numeric coordinates, and asserts the DB output
// (after `mapAggregateRows`) matches the oracle — including that junk-coord
// rows are excluded identically.
//
// Skips gracefully when no Postgres test DB is available (same gating as the
// other DB-backed suites, e.g. pinNumberUniqueness.property.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knex, { Knex } from 'knex';
import crypto from 'crypto';
import path from 'path';

import {
  buildHeatmapAggregateSql,
  mapAggregateRows,
  bucketIntoHeatmapCells,
  type HeatmapAggregateRow,
  type HeatmapInput,
  type HeatmapCell,
} from '../heatmap.utils.js';

// __tests__ → http → inbound → adapters → src → server
const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const migrationsDir = path.join(SERVER_ROOT, 'src', 'migrations');

function buildKnexConfig(): Knex.Config {
  return {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 1, max: 4 },
    migrations: { directory: migrationsDir, extension: 'ts' },
  };
}

function normalize(cells: HeatmapCell[]): HeatmapCell[] {
  return [...cells].sort((a, b) => (a.x - b.x) || (a.y - b.y));
}

let dbAvailable = false;
let db: Knex | null = null;
let setupError: string | null = null;
const seededUserIds: string[] = [];
const seededProjectIds: string[] = [];
const seededOrgIds: string[] = [];

describe('GAP 6: heatmap SQL aggregate parity on real Postgres', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
      setupError = 'SKIP_INTEGRATION_TESTS=true';
      return;
    }
    try {
      db = knex(buildKnexConfig());
      await db.raw('SELECT 1');
      await db.migrate.latest();
      dbAvailable = true;
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
      if (db) {
        await db.destroy().catch(() => {});
        db = null;
      }
      dbAvailable = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      if (seededProjectIds.length > 0) {
        await db('projects').whereIn('id', seededProjectIds).del();
      }
      if (seededUserIds.length > 0) {
        await db('users').whereIn('id', seededUserIds).del();
      }
      if (seededOrgIds.length > 0) {
        await db('organizations').whereIn('id', seededOrgIds).del();
      }
    } catch {
      // best-effort cleanup
    } finally {
      await db.destroy().catch(() => {});
      db = null;
    }
  });

  it('SQL GROUP BY floor(...) matches bucketIntoHeatmapCells, excluding junk coords', async (ctx) => {
    if (!dbAvailable || !db) {
      ctx.skip(`Postgres test DB unavailable: ${setupError ?? 'unknown'}`);
      return;
    }

    const CELL = 50;

    // --- Seed user + project + a page ---
    const userId = crypto.randomUUID();
    await db('users').insert({
      id: userId,
      email: `heatmap-${userId}@test.local`,
      name: 'Heatmap Test User',
      password_hash: 'placeholder-hash',
    });
    seededUserIds.push(userId);

    const projectId = crypto.randomUUID();
    await db('projects').insert({
      id: projectId,
      name: `heatmap-${projectId}`,
      urls: ['https://example.com/heatmap'],
      status: 'active',
      owner_id: userId,
      pin_counter: 0,
    });
    seededProjectIds.push(projectId);

    const pageId = crypto.randomUUID();
    await db('pages').insert({
      id: pageId,
      project_id: projectId,
      url: 'https://example.com/heatmap',
    });

    // The org_id the route filters on: seed a real organization so the
    // annotations.org_id FK is satisfied.
    const orgId = crypto.randomUUID();
    await db('organizations').insert({
      id: orgId,
      name: `Heatmap Org ${orgId}`,
      slug: `heatmap-${orgId}`,
    });
    seededOrgIds.push(orgId);

    // --- Valid rows (contribute to the oracle) ---
    const valid: HeatmapInput[] = [
      { pageX: 10, pageY: 10, severity: 'minor' },
      { pageX: 30, pageY: 40, severity: 'major' },
      { pageX: 60, pageY: 10, severity: 'critical' },
      { pageX: 70, pageY: 20, severity: 'critical' },
      { pageX: 120, pageY: 230, severity: 'informational' },
      { pageX: -10, pageY: -80, severity: 'minor' },
      // Same cell (200,200), 3x major + 1x minor: total must be 4. Guards the
      // regression where the outer count(*) counted severity groups (→ 2).
      { pageX: 201, pageY: 201, severity: 'major' },
      { pageX: 210, pageY: 220, severity: 'major' },
      { pageX: 230, pageY: 240, severity: 'major' },
      { pageX: 249, pageY: 249, severity: 'minor' },
      // Non-integer + exponent coordinates parse identically in both paths.
      { pageX: 12.5, pageY: 1e2, severity: 'minor' },
    ];

    // --- Junk rows (must be excluded by both paths) ---
    const junkTargets: unknown[] = [
      { pageY: 50 },                       // missing pageX
      { pageX: 'abc', pageY: 50 },         // non-numeric pageX
      { pageX: 50 },                       // missing pageY
      { pageX: null, pageY: null },        // null coords
    ];

    let pin = 1;
    const baseAnnotation = (target: unknown, severity: string) => ({
      id: crypto.randomUUID(),
      project_id: projectId,
      org_id: orgId,
      page_id: pageId,
      type: 'bug',
      severity,
      status: 'open',
      body: 'x',
      author_id: userId,
      target: JSON.stringify(target),
      pin_number: pin++,
    });

    const insertRows = [
      ...valid.map((v) => baseAnnotation({ pageX: v.pageX, pageY: v.pageY }, v.severity)),
      ...junkTargets.map((t) => baseAnnotation(t, 'minor')),
    ];
    await db('annotations').insert(insertRows);

    // --- Run the real SQL aggregate the route uses ---
    const { sql, bindings } = buildHeatmapAggregateSql({
      projectId,
      orgId,
      cellSize: CELL,
      pageIds: null,
    });
    const result = await db.raw(sql, bindings);
    const sqlCells = mapAggregateRows((result.rows ?? []) as HeatmapAggregateRow[]);

    // --- Oracle over the valid rows only ---
    const oracleCells = bucketIntoHeatmapCells(valid, CELL);

    expect(normalize(sqlCells)).toEqual(normalize(oracleCells));
    // Junk rows excluded: total equals the count of valid rows.
    expect(sqlCells.reduce((s, c) => s + c.count, 0)).toBe(valid.length);
  }, 60_000);
});
