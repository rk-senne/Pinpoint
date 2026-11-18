import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';
import { createBillingRoutes, type BillingRouteDeps } from './billing.routes.js';

function mockAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as any).user = { userId: 'u1', orgId: 'org1', role: 'admin', email: 'a@b.com' };
  next();
}

function makeDeps(overrides: Partial<BillingRouteDeps> = {}): BillingRouteDeps {
  return {
    authMiddleware: mockAuth,
    createCheckoutSession: { execute: vi.fn().mockResolvedValue('https://checkout.stripe.com/session') } as any,
    handleStripeWebhook: { execute: vi.fn().mockResolvedValue(undefined) } as any,
    getBillingPortal: { execute: vi.fn().mockResolvedValue('https://billing.stripe.com/portal') } as any,
    getUsageSummary: { execute: vi.fn().mockResolvedValue({ annotations: 10, projects: 2 }) } as any,
    db: vi.fn() as any,
    ...overrides,
  };
}

function makeApp(deps: BillingRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/billing', createBillingRoutes(deps));
  return app;
}

describe('billing.routes — checkout validation', () => {
  it('rejects missing URLs', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects non-URL strings', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ successUrl: 'not-a-url', cancelUrl: 'also-not' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects URLs with IP addresses (SSRF prevention)', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({
        successUrl: 'http://192.168.1.1/success',
        cancelUrl: 'https://example.com/cancel',
      });
    expect(res.status).toBe(400);
  });

  it('accepts valid URLs', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({
        successUrl: 'https://app.pinpoint.dev/billing/success',
        cancelUrl: 'https://app.pinpoint.dev/billing/cancel',
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/session');
  });
});

describe('billing.routes — webhook', () => {
  it('rejects missing stripe-signature header', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/webhook')
      .send({ type: 'invoice.paid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SIGNATURE');
  });
});

// =============================================================================
// GAP 3 — GET /api/v1/billing/invoices returns the shared { data, pagination }
// envelope and honours page/pageSize.
// =============================================================================
describe('billing.routes — GET /api/v1/billing/invoices (GAP 3)', () => {
  function paginatedTableMock(rows: any[], total: number) {
    const builder: any = {};
    const chain = () => builder;
    builder.where = vi.fn(chain);
    builder.orderBy = vi.fn(chain);
    builder.clone = vi.fn(chain);
    builder.limit = vi.fn(chain);
    builder.offset = vi.fn(() => Promise.resolve(rows));
    builder.count = vi.fn(() => Promise.resolve([{ count: total }]));
    return builder;
  }

  it('returns { data, pagination } and honours page/pageSize', async () => {
    const rows = [
      { id: 'inv-1', event_type: 'invoice.paid', data: { amount: 1200, status: 'paid' }, created_at: '2026-01-01' },
    ];
    const builder = paginatedTableMock(rows, 3);
    const db: any = vi.fn(() => builder);
    const app = makeApp(makeDeps({ db }));

    const res = await request(app).get('/api/v1/billing/invoices?page=2&pageSize=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual({
      id: 'inv-1',
      event_type: 'invoice.paid',
      amount: 1200,
      status: 'paid',
      created_at: '2026-01-01',
    });
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 1, total: 3, totalPages: 3 });
    expect(builder.limit).toHaveBeenCalledWith(1);
    expect(builder.offset).toHaveBeenCalledWith(1);
    expect(res.body.invoices).toBeUndefined();
  });
});

// =============================================================================
// GAP 7 — the canonical error envelope { error: { code, message, details? } }.
// Validation failures route through the shared sendZodFailure helper, so the
// Zod issues live under details.issues (flatten() shape), never a flat
// top-level `issues` and never a bare-string `error`.
// =============================================================================
describe('billing.routes — canonical error envelope (GAP 7)', () => {
  it('emits { error: { code, message } } with no bare string or flat issues', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ successUrl: 'not-a-url', cancelUrl: 'also-not' });

    expect(res.status).toBe(400);
    // Canonical shape: `error` is an object, never a bare string.
    expect(typeof res.body.error).toBe('object');
    expect(res.body.error.code).toBe('VALIDATION');
    expect(typeof res.body.error.message).toBe('string');
    // Zod issues standardized under details.issues (flatten() shape).
    expect(res.body.error.details).toBeDefined();
    expect(res.body.error.details.issues).toBeDefined();
    // No flat top-level `issues`.
    expect(res.body.issues).toBeUndefined();
  });
});

describe('billing.routes — roles and error hygiene (F-13)', () => {
  const asRole = (role: string) => (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    (req as any).user = { userId: 'u1', orgId: 'org1', role, email: 'a@b.com' };
    next();
  };
  const body = { successUrl: 'https://app.example.com/ok', cancelUrl: 'https://app.example.com/no' };

  it.each(['member', 'viewer', 'api_key'])('403s checkout and portal for role %s without calling Stripe', async (role) => {
    const deps = makeDeps({ authMiddleware: asRole(role) });
    const app = makeApp(deps);
    expect((await request(app).post('/api/v1/billing/checkout').send(body)).status).toBe(403);
    expect((await request(app).get('/api/v1/billing/portal')).status).toBe(403);
    expect((deps.createCheckoutSession as any).execute).not.toHaveBeenCalled();
    expect((deps.getBillingPortal as any).execute).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('allows %s to start checkout and open the portal', async (role) => {
    const app = makeApp(makeDeps({ authMiddleware: asRole(role) }));
    expect((await request(app).post('/api/v1/billing/checkout').send(body)).status).toBe(200);
    expect((await request(app).get('/api/v1/billing/portal')).status).toBe(200);
  });

  it('never echoes the underlying error message (checkout, portal, usage) and logs it instead', async () => {
    const leak = 'No such price: price_1ABC (key sk_live_SECRET)';
    const logged: unknown[] = [];
    const deps = makeDeps({
      createCheckoutSession: { execute: vi.fn().mockRejectedValue(new Error(leak)) } as any,
      getBillingPortal: { execute: vi.fn().mockRejectedValue(new Error(leak)) } as any,
      getUsageSummary: { execute: vi.fn().mockRejectedValue(new Error(leak)) } as any,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).log = { error: (obj: unknown) => logged.push(obj) };
      next();
    });
    app.use('/api/v1/billing', createBillingRoutes(deps));

    for (const res of [
      await request(app).post('/api/v1/billing/checkout').send(body),
      await request(app).get('/api/v1/billing/portal'),
      await request(app).get('/api/v1/billing/usage'),
    ]) {
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('BILLING_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/price_1ABC|sk_live|No such price/);
    }
    expect(logged).toHaveLength(3);
  });

  it('portal maps NO_STRIPE_CUSTOMER to a 404 with a fixed message', async () => {
    const app = makeApp(makeDeps({ getBillingPortal: { execute: vi.fn().mockRejectedValue(new Error('NO_STRIPE_CUSTOMER')) } as any }));
    const res = await request(app).get('/api/v1/billing/portal');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_SUBSCRIPTION');
    expect(res.body.error.message).not.toContain('NO_STRIPE_CUSTOMER');
  });
});
