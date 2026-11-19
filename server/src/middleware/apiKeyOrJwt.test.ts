import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';
import { createApiKeyOrJwtMiddleware, isApiKeyRouteAllowed } from './apiKeyOrJwt.js';
import { FakeApiKeyRepo } from '../__tests__/fakes/FakeApiKeyRepo.js';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';

const RAW = 'pk_' + 'a'.repeat(64);
const HASH = createHash('sha256').update(RAW).digest('hex');

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k1', orgId: 'org-1', name: 'mcp', keyPrefix: 'pk_aaaaaaaa',
    scopes: ['feedback:read', 'feedback:write'], createdBy: 'user-1',
    lastUsedAt: null, revokedAt: null, createdAt: new Date().toISOString(),
    keyType: 'standard', projectId: null, allowedOrigins: [], dailyQuota: null,
    ...overrides,
  };
}

function app(repo: FakeApiKeyRepo, db?: unknown) {
  const jwt = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === 'Bearer valid-jwt') {
      req.user = { userId: 'jwt-user', email: 'a@b.c', orgId: 'org-1', role: 'owner' };
      next();
      return;
    }
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' } });
  };
  const a = express();
  a.use(express.json());
  const mw = createApiKeyOrJwtMiddleware({ apiKeyRepo: repo, jwtMiddleware: jwt, ...(db ? { db: db as never } : {}) });
  const ok = (req: express.Request, res: express.Response) => res.json({ user: req.user });
  // Real-shaped paths: the allow-list is matched against `/api/v1/...`.
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    a[m]('/api/v1/{*rest}', mw, ok);
  }
  return a;
}

describe('createApiKeyOrJwtMiddleware', () => {
  let repo: FakeApiKeyRepo;
  beforeEach(() => { repo = new FakeApiKeyRepo(); });

  it('authenticates a standard key as its creator within its org', async () => {
    repo.seed(HASH, key());
    const res = await request(app(repo)).get('/api/v1/projects').set('Authorization', `Bearer ${RAW}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ userId: 'user-1', orgId: 'org-1', role: 'api_key' });
  });

  it('falls through to JWT auth for non-key bearers', async () => {
    const res = await request(app(repo)).get('/api/v1/projects').set('Authorization', 'Bearer valid-jwt');
    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe('jwt-user');
  });

  it('rejects an unknown or revoked key', async () => {
    const res = await request(app(repo)).get('/api/v1/projects').set('Authorization', `Bearer ${RAW}`);
    expect(res.status).toBe(401);
  });

  it('enforces scopes: read-only key can GET but not POST', async () => {
    repo.seed(HASH, key({ scopes: ['feedback:read'] }));
    expect((await request(app(repo)).get('/api/v1/projects').set('Authorization', `Bearer ${RAW}`)).status).toBe(200);
    // POST /annotations/:id/comments is on the allow-list, so this isolates the SCOPE check.
    const w = await request(app(repo)).post('/api/v1/annotations/a1/comments').set('Authorization', `Bearer ${RAW}`).send({});
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('rejects widget keys outright', async () => {
    const raw = 'pk_widget_' + 'b'.repeat(64);
    repo.seed(createHash('sha256').update(raw).digest('hex'), key({ keyType: 'widget' }));
    expect((await request(app(repo)).get('/api/v1/projects').set('Authorization', `Bearer ${raw}`)).status).toBe(401);
  });

  describe('route allow-list (F-18)', () => {
    const auth = () => ({ Authorization: `Bearer ${RAW}` });

    it('a feedback:write key can no longer delete a project or create/update projects', async () => {
      repo.seed(HASH, key());
      for (const [method, path] of [
        ['delete', '/api/v1/projects/p1'],
        ['post', '/api/v1/projects'],
        ['put', '/api/v1/projects/p1'],
        ['post', '/api/v1/projects/p1/export'],
        ['delete', '/api/v1/projects/p1/pages/pg1'],
        ['delete', '/api/v1/annotations/a1'],
        ['post', '/api/v1/annotations/a1/screenshot'],
        ['delete', '/api/v1/feedback/f1'],
        ['post', '/api/v1/feedback'],
        ['put', '/api/v1/annotations/a1'],
        ['post', '/api/v1/projects/p1/annotations'],
      ] as const) {
        const res = await request(app(repo))[method](path).set(auth()).send({});
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      }
    });

    it('keeps every call the MCP server makes working', async () => {
      repo.seed(HASH, key());
      for (const [method, path] of [
        ['get', '/api/v1/projects'],
        ['get', '/api/v1/projects?search=x&status=active'],
        ['get', '/api/v1/projects/p1'],
        ['get', '/api/v1/feedback?projectId=p1&page=1'],
        ['get', '/api/v1/feedback/f1'],
        ['patch', '/api/v1/feedback/f1'],
        ['get', '/api/v1/projects/p1/annotations'],
        ['get', '/api/v1/annotations/a1'],
        ['put', '/api/v1/annotations/a1/status'],
        ['get', '/api/v1/annotations/a1/comments'],
        ['post', '/api/v1/annotations/a1/comments'],
      ] as const) {
        const res = await request(app(repo))[method](path).set(auth()).send({});
        expect(res.status, `${method} ${path}`).toBe(200);
      }
    });

    it('isApiKeyRouteAllowed is exact (no prefix / traversal tricks)', () => {
      expect(isApiKeyRouteAllowed('GET', '/projects/p1/members')).toBe(false);
      expect(isApiKeyRouteAllowed('GET', '/projects/p1/analytics')).toBe(false);
      expect(isApiKeyRouteAllowed('GET', '/projects/p1/')).toBe(true);
      expect(isApiKeyRouteAllowed('GET', '/projects/../org/members')).toBe(false);
      expect(isApiKeyRouteAllowed('PUT', '/annotations/a1/status/extra')).toBe(false);
      expect(isApiKeyRouteAllowed('DELETE', '/annotations/a1/comments')).toBe(false);
    });

    it('JWT callers are not subject to the allow-list', async () => {
      const res = await request(app(repo)).delete('/api/v1/projects/p1').set('Authorization', 'Bearer valid-jwt').send({});
      expect(res.status).toBe(200);
    });
  });

  describe('creator membership (F-06)', () => {
    const dbWith = (member: boolean) =>
      (() => {
        const b: Record<string, unknown> = {};
        b.where = () => b;
        b.first = () => Promise.resolve(member ? { user_id: 'user-1' } : undefined);
        return b;
      }) as unknown;

    it('a key keeps working while its creator is still a member of the org', async () => {
      repo.seed(HASH, key());
      const res = await request(app(repo, dbWith(true))).get('/api/v1/projects').set('Authorization', `Bearer ${RAW}`);
      expect(res.status).toBe(200);
    });

    it('a key stops working once its creator was removed from the org', async () => {
      repo.seed(HASH, key());
      const res = await request(app(repo, dbWith(false))).get('/api/v1/projects').set('Authorization', `Bearer ${RAW}`);
      expect(res.status).toBe(401);
    });
  });
});
