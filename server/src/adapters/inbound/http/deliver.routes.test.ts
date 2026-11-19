import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import { createDeliverRoutes } from './deliver.routes.js';
import type { Integration, IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';
import {
  type TaskProvider,
  type TaskProviderName,
  type TaskResult,
  TASK_PROVIDERS,
  TaskDeliveryError,
} from '../../../services/integrations/index.js';

const ORG = 'org-1';
const ANN = 'ann-1';

/**
 * Minimal in-memory Knex stand-in covering exactly the two tables the deliver
 * route touches: `annotations` (read) and `annotation_external_links`
 * (read + upsert via onConflict/merge/returning).
 */
function makeDb(opts: {
  annotations: Array<Record<string, unknown>>;
  links?: Array<Record<string, unknown>>;
}) {
  const links = opts.links ? [...opts.links] : [];
  const now = '2026-11-13T12:00:00.000Z';

  const db: any = (table: string) => {
    if (table === 'annotations') {
      let whereArg: Record<string, unknown> = {};
      const b: any = {
        where: (arg: Record<string, unknown>) => {
          whereArg = arg;
          return b;
        },
        first: async () =>
          opts.annotations.find(
            (a) => a.id === whereArg.id && a.org_id === whereArg.org_id,
          ) ?? undefined,
      };
      return b;
    }
    if (table === 'annotation_external_links') {
      let whereArg: Record<string, unknown> = {};
      let insertRow: Record<string, unknown> = {};
      const b: any = {
        where: (arg: Record<string, unknown>) => {
          whereArg = arg;
          return b;
        },
        orderBy: () => b,
        first: async () =>
          links.find(
            (l) =>
              l.annotation_id === whereArg.annotation_id &&
              (whereArg.provider === undefined || l.provider === whereArg.provider),
          ) ?? undefined,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(
            links.filter((l) => l.annotation_id === whereArg.annotation_id),
          ).then(res, rej),
        insert: (row: Record<string, unknown>) => {
          insertRow = row;
          return b;
        },
        onConflict: () => b,
        merge: (patch: Record<string, unknown>) => {
          const existing = links.find(
            (l) => l.annotation_id === insertRow.annotation_id && l.provider === insertRow.provider,
          );
          if (existing) {
            Object.assign(existing, patch, { updated_at: now });
          } else {
            links.push({
              id: `link-${links.length + 1}`,
              created_at: now,
              updated_at: now,
              external_id: null,
              external_url: null,
              last_error: null,
              ...insertRow,
            });
          }
          return b;
        },
        returning: async () => {
          const row = links.find(
            (l) => l.annotation_id === insertRow.annotation_id && l.provider === insertRow.provider,
          );
          return [row];
        },
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  };
  db.fn = { now: () => now };
  return { db, links };
}

function mockAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as any).user = { userId: 'u1', orgId: ORG, role: 'admin', email: 'a@b.com' };
  next();
}

function makeIntegrationRepo(overrides: Partial<Integration> | null): IntegrationRepo {
  const integration: Integration | null =
    overrides === null
      ? null
      : {
          id: 'int-1',
          orgId: ORG,
          provider: 'github',
          accessToken: 'decrypted-token',
          config: { owner: 'acme', repo: 'web' },
          enabled: true,
          createdAt: '2026-01-01T00:00:00Z',
          ...overrides,
        };
  return {
    findByOrgAndProvider: vi.fn(async () => integration),
    listByOrg: vi.fn(async () => (integration ? [integration] : [])),
    upsert: vi.fn(),
    delete: vi.fn(),
  } as unknown as IntegrationRepo;
}

function stubProvider(
  name: TaskProviderName,
  impl: () => Promise<TaskResult>,
): Record<TaskProviderName, TaskProvider> {
  const providers = {} as Record<TaskProviderName, TaskProvider>;
  for (const p of TASK_PROVIDERS) {
    providers[p] = {
      provider: p,
      createTask: vi.fn(async () => {
        throw new TaskDeliveryError('not stubbed', { transient: false });
      }),
    };
  }
  providers[name] = { provider: name, createTask: vi.fn(impl) };
  return providers;
}

function makeApp(deps: Parameters<typeof createDeliverRoutes>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/annotations', createDeliverRoutes(deps));
  return app;
}

const ANNOTATION_ROW = {
  id: ANN,
  org_id: ORG,
  project_id: 'p1',
  pin_number: 3,
  body: 'Button overlaps footer',
  severity: 'major',
};

describe('POST /annotations/:id/deliver', () => {
  let db: any;

  beforeEach(() => {
    db = makeDb({ annotations: [ANNOTATION_ROW] }).db;
  });

  it('delivers to the provider and persists a delivered link (201)', async () => {
    const providers = stubProvider('github', async () => ({
      externalId: '42',
      externalUrl: 'https://github.com/acme/web/issues/42',
    }));
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db,
      providers,
      appUrl: 'https://app.pinpoint.test',
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });

    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({
      provider: 'github',
      externalId: '42',
      externalUrl: 'https://github.com/acme/web/issues/42',
      status: 'delivered',
    });

    // The adapter received the decrypted token + config + a deep-link url.
    const createTask = providers.github.createTask as any;
    expect(createTask).toHaveBeenCalledOnce();
    const [ctx, task] = createTask.mock.calls[0];
    expect(ctx.accessToken).toBe('decrypted-token');
    expect(ctx.config).toMatchObject({ owner: 'acme', repo: 'web' });
    expect(task.url).toContain('https://app.pinpoint.test/project/p1');
    expect(task.title).toContain('#3');
    expect(task.severity).toBe('Major');
  });

  it('is idempotent — re-delivery returns the existing delivered link without calling the provider', async () => {
    const seeded = makeDb({
      annotations: [ANNOTATION_ROW],
      links: [
        {
          id: 'link-1',
          annotation_id: ANN,
          provider: 'github',
          external_id: '42',
          external_url: 'https://github.com/acme/web/issues/42',
          status: 'delivered',
          last_error: null,
          created_at: '2026-11-13T10:00:00.000Z',
          updated_at: '2026-11-13T10:00:00.000Z',
        },
      ],
    });
    const providers = stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' }));
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: seeded.db,
      providers,
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });

    expect(res.status).toBe(200);
    expect(res.body.link.externalId).toBe('42');
    expect(providers.github.createTask).not.toHaveBeenCalled();
  });

  it('returns 409 INTEGRATION_NOT_CONNECTED when the provider is not connected', async () => {
    const providers = stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' }));
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo(null),
      db,
      providers,
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONNECTED');
    expect(providers.github.createTask).not.toHaveBeenCalled();
  });

  it('returns 409 when the integration exists but is disabled', async () => {
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({ enabled: false }),
      db,
      providers: stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' })),
    });
    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an annotation in another org (cross-org isolation)', async () => {
    const otherOrgDb = makeDb({
      annotations: [{ ...ANNOTATION_ROW, org_id: 'org-OTHER' }],
    }).db;
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: otherOrgDb,
      providers: stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' })),
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('records last_error and returns a canonical envelope on a permanent provider error (422)', async () => {
    const { db: failDb, links } = makeDb({ annotations: [ANNOTATION_ROW] });
    const providers = stubProvider('github', async () => {
      throw new TaskDeliveryError('422: Validation failed', { transient: false, status: 422 });
    });
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: failDb,
      providers,
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DELIVERY_FAILED');
    expect(res.body.error.message).toContain('Validation failed');
    // The failure is recorded.
    expect(links[0]).toMatchObject({ status: 'failed', last_error: '422: Validation failed' });
  });

  it('returns 502 on a transient provider error (retry by re-POSTing)', async () => {
    const { db: failDb, links } = makeDb({ annotations: [ANNOTATION_ROW] });
    const providers = stubProvider('github', async () => {
      throw new TaskDeliveryError('Upstream responded with HTTP 503', { transient: true, status: 503 });
    });
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: failDb,
      providers,
    });

    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'github' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DELIVERY_FAILED_TRANSIENT');
    expect(links[0].status).toBe('failed');
  });

  it('rejects an unknown provider with a 400 validation error', async () => {
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db,
      providers: stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' })),
    });
    const res = await request(app).post(`/api/v1/annotations/${ANN}/deliver`).send({ provider: 'bitbucket' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});

describe('GET /annotations/:id/deliveries', () => {
  it('lists the external links for the annotation', async () => {
    const seeded = makeDb({
      annotations: [ANNOTATION_ROW],
      links: [
        {
          id: 'link-1',
          annotation_id: ANN,
          provider: 'github',
          external_id: '42',
          external_url: 'https://github.com/acme/web/issues/42',
          status: 'delivered',
          last_error: null,
          created_at: '2026-11-13T10:00:00.000Z',
          updated_at: '2026-11-13T10:00:00.000Z',
        },
      ],
    });
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: seeded.db,
      providers: stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' })),
    });

    const res = await request(app).get(`/api/v1/annotations/${ANN}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ provider: 'github', status: 'delivered', externalId: '42' });
  });

  it('returns 404 for a cross-org annotation', async () => {
    const otherOrgDb = makeDb({ annotations: [{ ...ANNOTATION_ROW, org_id: 'org-OTHER' }] }).db;
    const app = makeApp({
      authMiddleware: mockAuth,
      integrationRepo: makeIntegrationRepo({}),
      db: otherOrgDb,
      providers: stubProvider('github', async () => ({ externalId: 'x', externalUrl: 'x' })),
    });
    const res = await request(app).get(`/api/v1/annotations/${ANN}/deliveries`);
    expect(res.status).toBe(404);
  });
});
