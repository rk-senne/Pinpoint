import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createHeatmapRoutes, type HeatmapRouteDeps } from '../heatmap.routes.js';

/**
 * Route-level tests for the heatmap endpoint — validates the coordinate
 * extraction (Bug 1 fix) and the pageUrl filtering (Bug 2 fix) using
 * a mocked Knex query builder and supertest.
 */

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: 'org-1', role: 'admin' };
  next();
}

interface MockDbOpts {
  annotations?: any[];
  /** Track whether whereIn was called (for pageUrl filter verification) */
  whereInSpy?: ReturnType<typeof vi.fn>;
}

function makeMockDb(opts: MockDbOpts = {}): any {
  const { annotations = [], whereInSpy } = opts;

  const db: any = vi.fn((table: string) => {
    if (table === 'pages') {
      // Sub-query builder for page_id filtering
      const pagesBuilder: any = {};
      const pagesChain = () => pagesBuilder;
      pagesBuilder.select = vi.fn(pagesChain);
      pagesBuilder.where = vi.fn(pagesChain);
      return pagesBuilder;
    }

    // annotations table builder
    const builder: any = {};
    const chain = () => builder;
    builder.where = vi.fn(chain);
    builder.whereNotNull = vi.fn(chain);
    builder.whereIn = whereInSpy ?? vi.fn(chain);
    builder.whereRaw = vi.fn(chain);
    builder.select = vi.fn(() => Promise.resolve(annotations));
    return builder;
  });

  return db;
}

function makeApp(deps: HeatmapRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  // Heatmap routes are mounted at /api/v1/projects
  app.use('/api/v1/projects', createHeatmapRoutes(deps));
  return app;
}

describe('heatmap.routes — GET /api/v1/projects/:id/heatmap', () => {
  it('returns correct cells from annotations with pageX/pageY (Bug 1 fix)', async () => {
    const annotations = [
      { target: { cssSelector: 'div', xpath: '/div', pageX: 120, pageY: 230, tagName: 'div', textSnippet: '' }, severity: 'critical' },
      { target: { cssSelector: 'p', xpath: '/p', pageX: 130, pageY: 210, tagName: 'p', textSnippet: '' }, severity: 'major' },
      { target: { cssSelector: 'a', xpath: '/a', pageX: 300, pageY: 400, tagName: 'a', textSnippet: '' }, severity: 'minor' },
    ];
    const db = makeMockDb({ annotations });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.cellSize).toBe(50);
    expect(res.body.totalAnnotations).toBe(3);
    expect(res.body.cells).toHaveLength(2);

    // Cell (100, 200): 2 annotations (120,230) and (130,210) both floor to (2,4) → (100,200)
    const hotCell = res.body.cells[0];
    expect(hotCell.x).toBe(100);
    expect(hotCell.y).toBe(200);
    expect(hotCell.count).toBe(2);
    expect(hotCell.severities).toEqual({ critical: 1, major: 1 });

    // Cell (300, 400): 1 annotation
    const coldCell = res.body.cells[1];
    expect(coldCell.x).toBe(300);
    expect(coldCell.y).toBe(400);
    expect(coldCell.count).toBe(1);
  });

  it('skips annotations with missing or non-numeric coordinates', async () => {
    const annotations = [
      { target: { pageX: 50, pageY: 50 }, severity: 'minor' },
      { target: { pageX: null, pageY: 50 }, severity: 'minor' },
      { target: { pageX: 'not-a-number', pageY: 50 }, severity: 'minor' },
      { target: { pageY: 50 }, severity: 'minor' },
      { target: null, severity: 'minor' },
      { target: { pageX: 50, pageY: NaN }, severity: 'minor' },
      { target: { pageX: Infinity, pageY: 50 }, severity: 'minor' },
    ];
    const db = makeMockDb({ annotations });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    // Only the first annotation has valid numeric coords
    expect(res.body.totalAnnotations).toBe(1);
    expect(res.body.cells).toHaveLength(1);
  });

  it('handles stringified target JSONB (Knex driver compat)', async () => {
    const annotations = [
      { target: JSON.stringify({ pageX: 75, pageY: 125, cssSelector: '.x', xpath: '/', tagName: 'div', textSnippet: '' }), severity: 'informational' },
    ];
    const db = makeMockDb({ annotations });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.totalAnnotations).toBe(1);
    expect(res.body.cells[0].x).toBe(50);
    expect(res.body.cells[0].y).toBe(100);
  });

  it('returns empty cells when no annotations exist', async () => {
    const db = makeMockDb({ annotations: [] });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app).get('/api/v1/projects/proj-1/heatmap');

    expect(res.status).toBe(200);
    expect(res.body.cellSize).toBe(50);
    expect(res.body.totalAnnotations).toBe(0);
    expect(res.body.cells).toEqual([]);
  });

  it('uses page_id sub-query when pageUrl is provided (Bug 2 fix)', async () => {
    const whereInSpy = vi.fn().mockReturnThis();
    const db = makeMockDb({ annotations: [], whereInSpy });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    await request(app)
      .get('/api/v1/projects/proj-1/heatmap?pageUrl=https://example.com/page');

    // whereIn should have been called with 'page_id' and a sub-query builder
    expect(whereInSpy).toHaveBeenCalledWith('page_id', expect.anything());
    // The second arg should be the pages sub-query (not a raw string or whereRaw)
    const subQueryArg = whereInSpy.mock.calls[0][1];
    // Verify it came from db('pages') — the mock returns an object with .select/.where
    expect(subQueryArg).toBeDefined();
  });

  it('does NOT call whereRaw with environment url (Bug 2 regression guard)', async () => {
    const annotations: any[] = [];
    const whereRawSpy = vi.fn().mockReturnThis();
    // Custom mock to track whereRaw
    const db: any = vi.fn((table: string) => {
      if (table === 'pages') {
        const pb: any = {};
        pb.select = vi.fn(() => pb);
        pb.where = vi.fn(() => pb);
        return pb;
      }
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.whereNotNull = vi.fn(chain);
      builder.whereIn = vi.fn(chain);
      builder.whereRaw = whereRawSpy;
      builder.select = vi.fn(() => Promise.resolve(annotations));
      return builder;
    });

    const app = makeApp({ authMiddleware: fakeAuth, db });

    await request(app)
      .get('/api/v1/projects/proj-1/heatmap?pageUrl=https://example.com');

    // The old broken code used whereRaw("environment->>'url' = ?", ...)
    // Verify that whereRaw is NEVER called
    expect(whereRawSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid pageUrl with 400', async () => {
    const db = makeMockDb({ annotations: [] });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .get('/api/v1/projects/proj-1/heatmap?pageUrl=not-a-url');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('does not select status column (perf — AC-7)', async () => {
    const selectSpy = vi.fn().mockResolvedValue([]);
    const db: any = vi.fn((table: string) => {
      if (table === 'pages') {
        const pb: any = {};
        pb.select = vi.fn(() => pb);
        pb.where = vi.fn(() => pb);
        return pb;
      }
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.whereNotNull = vi.fn(chain);
      builder.whereIn = vi.fn(chain);
      builder.whereRaw = vi.fn(chain);
      builder.select = selectSpy;
      return builder;
    });

    const app = makeApp({ authMiddleware: fakeAuth, db });
    await request(app).get('/api/v1/projects/proj-1/heatmap');

    // select should be called with only 'target' and 'severity', not 'status'
    expect(selectSpy).toHaveBeenCalledWith('target', 'severity');
  });
});
