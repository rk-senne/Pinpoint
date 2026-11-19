import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';
import { createWebhookRoutes, type WebhookRouteDeps } from './webhooks.routes.js';

const ORG_ID = 'a0000000-0000-4000-8000-000000000001';
const HOOK_ID = 'c0000000-0000-4000-8000-000000000001';

const asRole = (role: string) => (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role };
  next();
};

class EgressBlockedError extends Error {
  override name = 'EgressBlockedError';
}

function makeApp(role: string, overrides: Partial<WebhookRouteDeps> = {}) {
  const webhookRepo = {
    update: vi.fn().mockResolvedValue({ id: HOOK_ID, orgId: ORG_ID, url: 'https://hooks.example.com/x', events: ['annotation.created'], active: true, secret: 'whsec_x' }),
    findById: vi.fn().mockResolvedValue({ id: HOOK_ID }),
    countDeliveries: vi.fn().mockResolvedValue(0),
    listDeliveries: vi.fn().mockResolvedValue([]),
  };
  const deps: WebhookRouteDeps = {
    authMiddleware: asRole(role),
    registerWebhook: { execute: vi.fn().mockResolvedValue({ ok: true, value: { endpoint: { id: HOOK_ID } } }) } as any,
    deleteWebhook: { execute: vi.fn().mockResolvedValue({ ok: true, value: undefined }) } as any,
    webhookRepo: webhookRepo as any,
    db: Object.assign(vi.fn(() => ({ insert: vi.fn().mockResolvedValue([]) })), {}) as any,
    assertPublicUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/webhooks', createWebhookRoutes(deps));
  return { app, deps, webhookRepo };
}

describe('webhooks.routes — SSRF guard on PATCH (F-24)', () => {
  it('runs assertPublicUrl on a changed url and rejects blocked targets without updating', async () => {
    const { app, deps, webhookRepo } = makeApp('admin', {
      assertPublicUrl: vi.fn().mockRejectedValue(new EgressBlockedError('resolves to a private address')),
    });
    const res = await request(app).patch(`/api/v1/webhooks/${HOOK_ID}`).send({ url: 'https://169.254.169.254/latest' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(deps.assertPublicUrl).toHaveBeenCalledWith('https://169.254.169.254/latest');
    expect(webhookRepo.update).not.toHaveBeenCalled();
  });

  it('accepts a public url and updates', async () => {
    const { app, deps, webhookRepo } = makeApp('owner');
    const res = await request(app).patch(`/api/v1/webhooks/${HOOK_ID}`).send({ url: 'https://hooks.example.com/new' });
    expect(res.status).toBe(200);
    expect(deps.assertPublicUrl).toHaveBeenCalledWith('https://hooks.example.com/new');
    expect(webhookRepo.update).toHaveBeenCalled();
    expect(res.body.webhook.secret).toBeUndefined();
  });

  it('does not hit the guard when the url is unchanged (e.g. toggling active)', async () => {
    const { app, deps } = makeApp('admin');
    const res = await request(app).patch(`/api/v1/webhooks/${HOOK_ID}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(deps.assertPublicUrl).not.toHaveBeenCalled();
  });
});

describe('webhooks.routes — owner/admin only (F-10)', () => {
  it.each(['member', 'viewer', 'api_key'])('403s create / update / delete / deliveries for %s', async (role) => {
    const { app, deps, webhookRepo } = makeApp(role);
    const body = { url: 'https://hooks.example.com/x', events: ['annotation.created'] };
    expect((await request(app).post('/api/v1/webhooks').send(body)).status).toBe(403);
    expect((await request(app).patch(`/api/v1/webhooks/${HOOK_ID}`).send({ active: false })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/webhooks/${HOOK_ID}`)).status).toBe(403);
    expect((await request(app).get(`/api/v1/webhooks/${HOOK_ID}/deliveries`)).status).toBe(403);
    expect((deps.registerWebhook as any).execute).not.toHaveBeenCalled();
    expect((deps.deleteWebhook as any).execute).not.toHaveBeenCalled();
    expect(webhookRepo.update).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('allows %s to create and delete', async (role) => {
    const { app } = makeApp(role);
    expect((await request(app).post('/api/v1/webhooks').send({ url: 'https://hooks.example.com/x', events: ['annotation.created'] })).status).toBe(201);
    expect((await request(app).delete(`/api/v1/webhooks/${HOOK_ID}`)).status).toBe(204);
  });
});
