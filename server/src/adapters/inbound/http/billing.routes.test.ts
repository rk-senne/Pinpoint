import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
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
