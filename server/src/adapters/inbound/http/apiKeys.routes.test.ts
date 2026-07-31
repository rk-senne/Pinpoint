import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createApiKeyRoutes, type ApiKeyRouteDeps } from './apiKeys.routes.js';

/**
 * Route tests for api-keys endpoints. Validates the IDOR fix:
 * DELETE /api/v1/api-keys/:id must verify the key belongs to the
 * caller's org before revoking (cross-tenant IDOR prevention).
 */

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';
const KEY_ID = 'c0000000-0000-0000-0000-000000000001';
const USER_ID = 'u0000000-0000-0000-0000-000000000001';

function fakeAuth(role: string = 'admin', orgId: string = ORG_ID) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).user = { userId: USER_ID, email: 'admin@test.com', orgId, role };
    next();
  };
}

interface MockDbOpts {
  /** Simulated api_keys row returned by `.first()` (undefined = not found / cross-tenant) */
  apiKey?: { id: string; org_id: string } | undefined;
}

function makeMockDb(opts: MockDbOpts = {}): any {
  const { apiKey } = opts;

  const db: any = vi.fn((table: string) => {
    if (table === 'api_keys') {
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.first = vi.fn(() => Promise.resolve(apiKey));
      builder.update = vi.fn(() => Promise.resolve(1));
      return builder;
    }

    if (table === 'audit_log') {
      const builder: any = {};
      builder.insert = vi.fn(() => Promise.resolve());
      return builder;
    }

    // Default fallback
    const builder: any = {};
    const chain = () => builder;
    builder.where = vi.fn(chain);
    builder.first = vi.fn(() => Promise.resolve(undefined));
    builder.insert = vi.fn(() => Promise.resolve());
    return builder;
  });

  // Knex function property for .fn.now()
  db.fn = { now: vi.fn(() => 'now()') };

  return db;
}

function makeMockApiKeyRepo(): any {
  return {
    insert: vi.fn(),
    findByHash: vi.fn(),
    listByOrg: vi.fn(() => Promise.resolve([])),
    revoke: vi.fn(() => Promise.resolve()),
    updateLastUsed: vi.fn(),
  };
}

function makeApp(deps: ApiKeyRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/api-keys', createApiKeyRoutes(deps));
  return app;
}

describe('apiKeys.routes — DELETE /api/v1/api-keys/:id (IDOR fix)', () => {
  it('returns 404 when API key does not belong to caller org (cross-tenant IDOR)', async () => {
    // Key exists in OTHER org but not in caller's org → lookup returns undefined
    const db = makeMockDb({ apiKey: undefined });
    const apiKeyRepo = makeMockApiKeyRepo();
    const app = makeApp({ authMiddleware: fakeAuth('admin', ORG_ID), apiKeyRepo, db });

    const res = await request(app)
      .delete(`/api/v1/api-keys/${KEY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('API key not found.');

    // Verify the api_keys table was queried with org_id scope
    expect(db).toHaveBeenCalledWith('api_keys');
    const apiKeysCallIdx = db.mock.calls.findIndex((c: any[]) => c[0] === 'api_keys');
    const apiKeysBuilder = db.mock.results[apiKeysCallIdx].value;
    expect(apiKeysBuilder.where).toHaveBeenCalledWith({
      id: KEY_ID,
      org_id: ORG_ID,
    });

    // revoke should NOT have been called
    expect(apiKeyRepo.revoke).not.toHaveBeenCalled();
  });

  it('allows revocation when API key belongs to caller org', async () => {
    const ownedKey = { id: KEY_ID, org_id: ORG_ID };
    const db = makeMockDb({ apiKey: ownedKey });
    const apiKeyRepo = makeMockApiKeyRepo();
    const app = makeApp({ authMiddleware: fakeAuth('admin', ORG_ID), apiKeyRepo, db });

    const res = await request(app)
      .delete(`/api/v1/api-keys/${KEY_ID}`);

    expect(res.status).toBe(204);
    expect(apiKeyRepo.revoke).toHaveBeenCalledWith(KEY_ID);
  });

  it('returns 403 when caller lacks owner/admin role', async () => {
    const db = makeMockDb({ apiKey: { id: KEY_ID, org_id: ORG_ID } });
    const apiKeyRepo = makeMockApiKeyRepo();
    const app = makeApp({ authMiddleware: fakeAuth('member', ORG_ID), apiKeyRepo, db });

    const res = await request(app)
      .delete(`/api/v1/api-keys/${KEY_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(apiKeyRepo.revoke).not.toHaveBeenCalled();
  });

  it('returns 400 for non-UUID id parameter', async () => {
    const db = makeMockDb({});
    const apiKeyRepo = makeMockApiKeyRepo();
    const app = makeApp({ authMiddleware: fakeAuth('admin', ORG_ID), apiKeyRepo, db });

    const res = await request(app)
      .delete('/api/v1/api-keys/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
