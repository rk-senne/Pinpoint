import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';

import { createApiKeyMiddleware } from './apiKeyAuth.js';
import { FakeApiKeyRepo } from '../__tests__/fakes/FakeApiKeyRepo.js';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';

const ORG_ID = 'a0000000-0000-4000-8000-000000000001';
const STD_RAW = 'pk_standardkey';
const STD_HASH = createHash('sha256').update(STD_RAW).digest('hex');
const WIDGET_RAW = 'pk_widget_leaked';
const WIDGET_HASH = createHash('sha256').update(WIDGET_RAW).digest('hex');

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k0000000-0000-0000-0000-000000000001',
    orgId: ORG_ID,
    name: 'key',
    keyPrefix: 'pk_',
    scopes: ['feedback:write'],
    createdBy: 'u0000000-0000-0000-0000-000000000001',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    keyType: 'standard',
    projectId: null,
    allowedOrigins: [],
    dailyQuota: null,
    ...overrides,
  };
}

function makeApp(apiKeyRepo: FakeApiKeyRepo) {
  const app = express();
  app.use(createApiKeyMiddleware({ apiKeyRepo }));
  app.get('/probe', (req, res) => res.json({ orgId: (req as any).user?.orgId ?? null }));
  return app;
}

describe('apiKeyAuth — widget key rejection (A1)', () => {
  let apiKeyRepo: FakeApiKeyRepo;

  beforeEach(() => {
    apiKeyRepo = new FakeApiKeyRepo();
  });

  it('rejects a pk_widget_ key presented as Bearer (401, no DB lookup escalation)', async () => {
    apiKeyRepo.seed(WIDGET_HASH, key({ keyType: 'widget', keyPrefix: 'pk_widget_', scopes: ['widget'] }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app).get('/probe').set('Authorization', `Bearer ${WIDGET_RAW}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('authenticates a standard Bearer key', async () => {
    apiKeyRepo.seed(STD_HASH, key());
    const app = makeApp(apiKeyRepo);
    const res = await request(app).get('/probe').set('Authorization', `Bearer ${STD_RAW}`);
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_ID);
  });

  it('falls through (no user) when there is no Bearer pk_ header', async () => {
    const app = makeApp(apiKeyRepo);
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBeNull();
  });

  it('rejects a widget-type key even if it somehow lacks the prefix', async () => {
    // Defense in depth: keyType is the authoritative discriminator.
    apiKeyRepo.seed(STD_HASH, key({ keyType: 'widget' }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app).get('/probe').set('Authorization', `Bearer ${STD_RAW}`);
    expect(res.status).toBe(401);
  });
});
