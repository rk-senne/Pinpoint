import { describe, it, expect, vi } from 'vitest';
import type { WebhookEndpoint } from '../Webhook.js';
import type { WebhookRepo } from '../ports/WebhookRepo.js';
import { RegisterWebhook } from '../usecases/webhooks.js';
import { EgressBlockedError } from '../../../services/egressGuard.js';

function makeRepo(): WebhookRepo {
  return {
    insert: vi.fn(async (ep): Promise<WebhookEndpoint> => ({
      id: 'ep-1',
      orgId: ep.orgId,
      url: ep.url,
      secret: ep.secret,
      events: ep.events,
      active: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })),
    listByOrg: vi.fn() as any,
    findById: vi.fn() as any,
    update: vi.fn() as any,
    delete: vi.fn() as any,
    findByOrgAndEvent: vi.fn() as any,
    enqueueDelivery: vi.fn() as any,
    claimDueDeliveries: vi.fn() as any,
    markDeliverySent: vi.fn() as any,
    markDeliveryPending: vi.fn() as any,
    markDeliveryFailed: vi.fn() as any,
    findEndpointById: vi.fn() as any,
    listDeliveries: vi.fn() as any,
    countDeliveries: vi.fn() as any,
  };
}

describe('RegisterWebhook SSRF guard (A5a)', () => {
  it('rejects a URL the egress guard blocks', async () => {
    const repo = makeRepo();
    const uc = new RegisterWebhook({
      webhookRepo: repo,
      assertPublicUrl: async () => {
        throw new EgressBlockedError('Blocked IP address: 169.254.169.254');
      },
    });

    const res = await uc.execute({
      orgId: 'org-1',
      url: 'https://169.254.169.254/hook',
      events: ['annotation.created'],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('Validation');
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('registers when the guard passes', async () => {
    const repo = makeRepo();
    const assertPublicUrl = vi.fn(async () => undefined);
    const uc = new RegisterWebhook({ webhookRepo: repo, assertPublicUrl });

    const res = await uc.execute({
      orgId: 'org-1',
      url: 'https://hook.example.com/wh',
      events: ['annotation.created'],
    });

    expect(res.ok).toBe(true);
    expect(assertPublicUrl).toHaveBeenCalledWith('https://hook.example.com/wh');
    expect(repo.insert).toHaveBeenCalledOnce();
    const inserted = (repo.insert as any).mock.calls[0][0];
    expect(inserted.secret.startsWith('whsec_')).toBe(true);
  });

  it('rejects invalid event types before touching the guard', async () => {
    const repo = makeRepo();
    const assertPublicUrl = vi.fn(async () => undefined);
    const uc = new RegisterWebhook({ webhookRepo: repo, assertPublicUrl });

    const res = await uc.execute({
      orgId: 'org-1',
      url: 'https://hook.example.com/wh',
      events: ['bogus.event'],
    });

    expect(res.ok).toBe(false);
    expect(assertPublicUrl).not.toHaveBeenCalled();
  });

  it('rejects a syntactically invalid URL', async () => {
    const repo = makeRepo();
    const uc = new RegisterWebhook({ webhookRepo: repo, assertPublicUrl: async () => undefined });

    const res = await uc.execute({
      orgId: 'org-1',
      url: 'not a url',
      events: ['annotation.created'],
    });

    expect(res.ok).toBe(false);
  });
});
