import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import { createGuidelinesRoutes, type GuidelinesRouteDeps } from './guidelines.routes.js';
import type { Guideline } from '../../../domain/guideline/Guideline.js';
import { ListGuidelines } from '../../../domain/guideline/usecases/listGuidelines.js';
import { CreateCustomGuideline } from '../../../domain/guideline/usecases/createCustomGuideline.js';
import { FakeGuidelineRepo } from '../../../__tests__/fakes/index.js';

/**
 * Route tests for the guideline catalogue endpoint.
 *
 * GAP 3: GET /api/v1/guidelines must emit the shared { data, pagination }
 * envelope (page, pageSize, total, totalPages) instead of the legacy
 * `{ guidelines }` keyed object, and honour page/pageSize.
 */

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: 'org1', role: 'admin' };
  next();
}

function makeGuideline(overrides: Partial<Guideline> = {}): Guideline {
  return {
    id: overrides.id ?? 'g1',
    name: overrides.name ?? 'Visibility of system status',
    description: overrides.description ?? 'Keep users informed.',
    isDefault: overrides.isDefault ?? true,
    createdByUserId: overrides.createdByUserId,
  } as Guideline;
}

function makeDeps(guidelines: Guideline[]): GuidelinesRouteDeps {
  return {
    authMiddleware: fakeAuth,
    listGuidelines: { execute: vi.fn().mockResolvedValue({ ok: true, value: guidelines }) } as any,
    createCustomGuideline: { execute: vi.fn() } as any,
  };
}

function makeApp(deps: GuidelinesRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/guidelines', createGuidelinesRoutes(deps));
  return app;
}

describe('guidelines.routes — GET /api/v1/guidelines (GAP 3)', () => {
  it('returns the shared { data, pagination } envelope', async () => {
    const guidelines = [
      makeGuideline({ id: 'g1', name: 'One' }),
      makeGuideline({ id: 'g2', name: 'Two', isDefault: false }),
    ];
    const app = makeApp(makeDeps(guidelines));

    const res = await request(app).get('/api/v1/guidelines');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe('g1');
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 25, total: 2, totalPages: 1 });
    // No legacy `guidelines` key.
    expect(res.body.guidelines).toBeUndefined();
  });

  it('honours page/pageSize by slicing the in-memory catalogue', async () => {
    const guidelines = Array.from({ length: 5 }, (_, i) =>
      makeGuideline({ id: `g${i}`, name: `G${i}`, isDefault: false }),
    );
    const app = makeApp(makeDeps(guidelines));

    const res = await request(app).get('/api/v1/guidelines?page=2&pageSize=2');

    expect(res.status).toBe(200);
    expect(res.body.data.map((g: any) => g.id)).toEqual(['g2', 'g3']);
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
  });
});

describe('guidelines.routes — org isolation', () => {
  function orgApp() {
    const repo = new FakeGuidelineRepo();
    const deps: GuidelinesRouteDeps = {
      authMiddleware: (req, res, next) => {
        const org = req.headers['x-org'];
        if (typeof org !== 'string') {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'no' } });
          return;
        }
        (req as any).user = { userId: `user-${org}`, email: 'a@b.com', orgId: org, role: 'admin' };
        next();
      },
      listGuidelines: new ListGuidelines({ guidelineRepo: repo }),
      createCustomGuideline: new CreateCustomGuideline({ guidelineRepo: repo }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/guidelines', createGuidelinesRoutes(deps));
    return { app, repo };
  }

  it('never shows one org\'s custom guidelines to another org, while defaults stay global', async () => {
    const { app, repo } = orgApp();
    await repo.insert({ name: 'Nielsen 1', description: 'd', isDefault: true });

    const created = await request(app)
      .post('/api/v1/guidelines')
      .set('x-org', 'orgA')
      .send({ name: 'A-only secret', description: 'x' });
    expect(created.status).toBe(201);

    const names = async (org: string) =>
      ((await request(app).get('/api/v1/guidelines').set('x-org', org)).body.data as Array<{ name: string }>).map(
        (g) => g.name,
      );
    expect(await names('orgA')).toEqual(['Nielsen 1', 'A-only secret']);
    expect(await names('orgB')).toEqual(['Nielsen 1']);
  });

  it('stores the caller\'s org on create', async () => {
    const { app, repo } = orgApp();
    await request(app).post('/api/v1/guidelines').set('x-org', 'orgB').send({ name: 'B', description: 'x' });
    expect([...repo.guidelines.values()][0]?.orgId).toBe('orgB');
  });
});

describe('guidelines.routes — no shared response cache', () => {
  it('an unauthenticated request after an authenticated one is rejected, not replayed', async () => {
    const { app } = (() => {
      const repo = new FakeGuidelineRepo();
      const deps: GuidelinesRouteDeps = {
        authMiddleware: (req, res, next) => {
          if (req.headers.authorization !== 'Bearer ok') {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'no' } });
            return;
          }
          fakeAuth(req, res, next);
        },
        listGuidelines: new ListGuidelines({ guidelineRepo: repo }),
        createCustomGuideline: new CreateCustomGuideline({ guidelineRepo: repo }),
      };
      const a = express();
      a.use(express.json());
      a.use('/api/v1/guidelines', createGuidelinesRoutes(deps));
      return { app: a };
    })();
    const authed = await request(app).get('/api/v1/guidelines').set('Authorization', 'Bearer ok');
    expect(authed.status).toBe(200);
    expect(authed.headers['x-cache']).toBeUndefined();
    const anon = await request(app).get('/api/v1/guidelines');
    expect(anon.status).toBe(401);
  });
});
