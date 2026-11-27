import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../../__tests__/supertestClient.js';

import { createHeatmapRoutes, type HeatmapRouteDeps } from '../heatmap.routes.js';
import {
  buildHeatmapAggregateSql,
  bucketIntoHeatmapCells,
  type HeatmapInput,
} from '../heatmap.utils.js';

/**
 * Route-level tests for the heatmap endpoint. Density is now computed by a
 * Postgres `GROUP BY floor(...)` aggregate (GAP 6), so these tests mock
 * `db.raw` (returning pre-aggregated rows exactly as Postgres would) plus the
 * `db('pages')` resolution used for the optional `pageUrl` filter. The SQL
 * shape itself is exercised against a real DB in
 * `heatmap.sqlAggregate.integration.test.ts`; parity with the oracle lives in
 * `heatmap.parity.property.test.ts`.
 */

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: 'org-1', role: 'admin' };
  next();
}

interface MockDbOpts {
  /** Pre-aggregated rows db.raw should resolve to (as Postgres would return). */
  rawRows?: any[];
  /** Pages the pages sub-query should resolve to. */
  pages?: Array<{ id: string }>;
  rawSpy?: ReturnType<typeof vi.fn>;
  pagesWhereSpy?: ReturnType<typeof vi.fn>;
}

function makeMockDb(opts: MockDbOpts = {}): any {
  const { rawRows = [], pages = [], rawSpy, pagesWhereSpy } = opts;

  const db: any = vi.fn((table: string) => {
    if (table === 'projects') {
      // Project access check (org match + owner): caller `u1` owns the project.
      const projectBuilder: any = {};
      projectBuilder.where = vi.fn(() => projectBuilder);
      projectBuilder.first = vi.fn(() => Promise.resolve({ id: 'proj-1', org_id: 'org-1', owner_id: 'u1' }));
      return projectBuilder;
    }
    if (table === 'pages') {
      const pagesBuilder: any = {};
      pagesBuilder.select = vi.fn(() => pagesBuilder);
      pagesBuilder.where = pagesWhereSpy
        ? pagesWhereSpy.mockReturnValue(Promise.resolve(pages))
        : vi.fn(() => Promise.resolve(pages));
      return pagesBuilder;
    }
    throw new Error(`unexpected table ${table}`);
  });

  db.raw = rawSpy ?? vi.fn(() => Promise.resolve({ rows: rawRows }));
  return db;
}

function makeApp(deps: HeatmapRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/projects', createHeatmapRoutes(deps));
  return app;
}

describe('heatmap.routes — GET /api/v1/projects/:id/heatmap', () => {
  it('maps pre-aggregated Postgres rows into the response shape', async () => {
    const rawRows = [
      { x: 100, y: 200, count: 2, severities: { critical: 1, major: 1 } },
      { x: 300, y: 400, count: 1, severities: { minor: 1 } },
    ];
    const db = makeMockDb({ rawRows });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.cellSize).toBe(50);
    expect(res.body.totalAnnotations).toBe(3);
    expect(res.body.cells).toHaveLength(2);

    const hotCell = res.body.cells[0];
    expect(hotCell).toEqual({ x: 100, y: 200, count: 2, severities: { critical: 1, major: 1 } });
    expect(res.body.cells[1]).toEqual({ x: 300, y: 400, count: 1, severities: { minor: 1 } });
  });

  it('parses stringified JSONB severities (driver compat)', async () => {
    const rawRows = [
      { x: 50, y: 100, count: 1, severities: JSON.stringify({ informational: 1 }) },
    ];
    const db = makeMockDb({ rawRows });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.cells[0].severities).toEqual({ informational: 1 });
  });

  it('returns empty cells when the aggregate yields no rows', async () => {
    const db = makeMockDb({ rawRows: [] });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.cellSize).toBe(50);
    expect(res.body.totalAnnotations).toBe(0);
    expect(res.body.cells).toEqual([]);
  });

  it('passes the project/org and cell size bindings into db.raw', async () => {
    const rawSpy = vi.fn((_sql: string, _bindings: unknown[]) => Promise.resolve({ rows: [] }));
    const db = makeMockDb({ rawSpy });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(rawSpy).toHaveBeenCalledTimes(1);
    const [sql, bindings] = rawSpy.mock.calls[0];
    expect(sql).toContain("(target->>'pageX')::numeric");
    expect(sql).toContain("(target->>'pageY')::numeric");
    expect(sql).toContain('GROUP BY cell_x, cell_y');
    expect(sql).toContain('ORDER BY count DESC');
    // project_id + org_id are part of the bindings
    expect(bindings).toContain('proj-1');
    expect(bindings).toContain('org-1');
    // cell size (50) appears among the floor-division bindings
    expect(bindings).toContain(50);
  });

  it('resolves pageUrl to page ids and includes them in the aggregate (Bug 2 behavior preserved)', async () => {
    const rawSpy = vi.fn((_sql: string, _bindings: unknown[]) => Promise.resolve({ rows: [] }));
    const pagesWhereSpy = vi.fn();
    const db = makeMockDb({
      rawSpy,
      pages: [{ id: 'page-a' }, { id: 'page-b' }],
      pagesWhereSpy,
    });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    await request(app).get('/api/v1/projects/proj-1/heatmap?pageUrl=https://example.com/page');

    // pages sub-query scoped to the project + url
    expect(pagesWhereSpy).toHaveBeenCalledWith({
      project_id: 'proj-1',
      url: 'https://example.com/page',
    });
    // resolved page ids flow into the aggregate bindings
    const [sql, bindings] = rawSpy.mock.calls[0];
    expect(sql).toContain('page_id IN');
    expect(bindings).toContain('page-a');
    expect(bindings).toContain('page-b');
  });

  it('matches nothing when pageUrl resolves to zero pages', async () => {
    const rawSpy = vi.fn((_sql: string, _bindings: unknown[]) => Promise.resolve({ rows: [] }));
    const db = makeMockDb({ rawSpy, pages: [] });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    await request(app).get('/api/v1/projects/proj-1/heatmap?pageUrl=https://example.com/none');

    const [sql] = rawSpy.mock.calls[0];
    expect(sql).toContain('1 = 0');
  });

  it('rejects invalid pageUrl with 400', async () => {
    const db = makeMockDb({ rawRows: [] });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap?pageUrl=not-a-url');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('end-to-end shape check: builder SQL fed oracle-equivalent rows round-trips', async () => {
    // Build the SQL the route would build, then simulate Postgres by running
    // the oracle over the "stored" inputs and feeding those cells back as the
    // raw rows — asserting the route returns exactly the oracle output.
    const inputs: HeatmapInput[] = [
      { pageX: 10, pageY: 10, severity: 'minor' },
      { pageX: 60, pageY: 10, severity: 'major' },
      { pageX: 70, pageY: 20, severity: 'critical' },
    ];
    const oracleCells = bucketIntoHeatmapCells(inputs, 50);

    const { sql, bindings } = buildHeatmapAggregateSql({
      projectId: 'proj-1',
      orgId: 'org-1',
      cellSize: 50,
      pageIds: null,
    });
    expect(sql).toContain('jsonb_object_agg(severity, sev_count)');
    expect(bindings).toContain('proj-1');

    const db = makeMockDb({ rawRows: oracleCells });
    const app = makeApp({ authMiddleware: fakeAuth, db });
    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.body.cells).toEqual(oracleCells);
    expect(res.body.totalAnnotations).toBe(inputs.length);
  });
});
