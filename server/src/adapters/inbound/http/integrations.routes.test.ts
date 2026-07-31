import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createIntegrationsRoutes, type IntegrationsRouteDeps } from './integrations.routes.js';
import type { IntegrationRepo, Integration } from '../../../domain/integration/ports/IntegrationRepo.js';

const CANNED_INTEGRATION: Integration = {
  id: 'int-1',
  orgId: 'org-123',
  provider: 'slack',
  accessToken: 'tok',
  config: {},
  enabled: true,
  createdAt: '2024-01-01T00:00:00Z',
};

function mockAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as any).user = { userId: 'u1', orgId: 'org-123', role: 'admin', email: 'a@b.com' };
  next();
}

function makeDeps(overrides: Partial<IntegrationsRouteDeps> = {}): IntegrationsRouteDeps {
  return {
    authMiddleware: mockAuth,
    integrationRepo: {
      findByOrgAndProvider: vi.fn().mockResolvedValue(CANNED_INTEGRATION),
      listByOrg: vi.fn().mockResolvedValue([CANNED_INTEGRATION]),
      upsert: vi.fn().mockResolvedValue(CANNED_INTEGRATION),
      delete: vi.fn().mockResolvedValue(true),
    },
    ...overrides,
  };
}

function makeApp(deps: IntegrationsRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/integrations', createIntegrationsRoutes(deps));
  return app;
}

/** Helper: build a signed cookie value for integration_oauth_state */
function buildStateCookie(payload: { state: string; orgId: string; provider: string }): string {
  return `integration_oauth_state=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe('integrations.routes — IDOR/CSRF security fix', () => {
  describe('POST /:provider/connect sets state cookie (AC-1)', () => {
    it('sets an HttpOnly SameSite=Lax cookie with random state and orgId', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await request(app)
        .post('/api/v1/integrations/slack/connect')
        .send({});

      expect(res.status).toBe(200);

      // Check Set-Cookie header
      const cookies = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
      const stateCookieHeader = cookies.find((c: string) => c.includes('integration_oauth_state'));
      expect(stateCookieHeader).toBeDefined();
      expect(stateCookieHeader).toMatch(/HttpOnly/i);
      expect(stateCookieHeader).toMatch(/SameSite=Lax/i);

      // Parse the cookie value
      const match = stateCookieHeader!.match(/integration_oauth_state=([^;]+)/);
      expect(match).not.toBeNull();
      const parsed = JSON.parse(decodeURIComponent(match![1]));
      expect(parsed.orgId).toBe('org-123');
      expect(parsed.provider).toBe('slack');
      expect(parsed.state).toMatch(/^[0-9a-f]{32}$/);

      // redirectUrl contains the random state, NOT the orgId
      expect(res.body.redirectUrl).toContain(`state=${parsed.state}`);
      expect(res.body.redirectUrl).not.toContain('org-123');
    });
  });

  describe('GET /:provider/callback — valid state (AC-2)', () => {
    it('upserts with orgId from cookie when state matches', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      // Step 1: call connect to get a real cookie
      const connectRes = await request(app)
        .post('/api/v1/integrations/slack/connect')
        .send({});

      const setCookies = (Array.isArray(connectRes.headers['set-cookie']) ? connectRes.headers['set-cookie'] : [connectRes.headers['set-cookie']]) as string[];
      const stateCookieHeader = setCookies.find((c: string) => c.includes('integration_oauth_state'))!;
      const cookieMatch = stateCookieHeader.match(/integration_oauth_state=([^;]+)/)!;
      const parsed = JSON.parse(decodeURIComponent(cookieMatch[1]));

      // Step 2: call callback with the state from the cookie
      const callbackRes = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc123&state=${parsed.state}`)
        .set('Cookie', `integration_oauth_state=${cookieMatch[1]}`);

      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body.integration).toBeDefined();

      // Verify upsert was called with orgId from the cookie, not from the query param
      expect(deps.integrationRepo.upsert).toHaveBeenCalledWith(
        'org-123', // orgId from cookie
        'slack',
        expect.objectContaining({ accessToken: 'exchanged_abc123' }),
      );
    });

    it('derives orgId from cookie, ignoring any spoofed state value (AC-2 variant)', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'a'.repeat(32);
      // Cookie has orgId='org-123', but an attacker might try to spoof via state
      const cookiePayload = { state: nonce, orgId: 'org-123', provider: 'slack' };

      const callbackRes = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(callbackRes.status).toBe(200);
      // Even though an attacker could control the state query param, orgId comes from the cookie
      expect(deps.integrationRepo.upsert).toHaveBeenCalledWith(
        'org-123', // from cookie, NOT from query
        'slack',
        expect.anything(),
      );
    });
  });

  describe('GET /:provider/callback — no cookie (AC-3)', () => {
    it('returns 400 and does not call upsert when cookie is missing', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await request(app)
        .get('/api/v1/integrations/slack/callback?code=abc&state=anything');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('Invalid or expired OAuth state');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /:provider/callback — state mismatch (AC-4)', () => {
    it('returns 400 and does not call upsert when state query != cookie state', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const cookiePayload = { state: 'correct-nonce', orgId: 'org-123', provider: 'slack' };

      const res = await request(app)
        .get('/api/v1/integrations/slack/callback?code=abc&state=wrong-nonce')
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('Invalid or expired OAuth state');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /:provider/callback — provider mismatch (AC-5)', () => {
    it('returns 400 when URL provider differs from cookie provider', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'b'.repeat(32);
      const cookiePayload = { state: nonce, orgId: 'org-123', provider: 'slack' };

      // Cookie says slack, but calling jira callback
      const res = await request(app)
        .get(`/api/v1/integrations/jira/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('Invalid or expired OAuth state');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /:provider/callback — cookie cleared on both paths (AC-6)', () => {
    it('clears cookie on success', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'c'.repeat(32);
      const cookiePayload = { state: nonce, orgId: 'org-123', provider: 'slack' };

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(res.status).toBe(200);
      const cookies = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
      const clearCookie = cookies?.find((c: string) => c.includes('integration_oauth_state'));
      expect(clearCookie).toBeDefined();
      // Cleared cookies have an Expires in the past or Max-Age=0
      expect(clearCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('clears cookie on state mismatch failure', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const cookiePayload = { state: 'aaa', orgId: 'org-123', provider: 'slack' };

      const res = await request(app)
        .get('/api/v1/integrations/slack/callback?code=abc&state=bbb')
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(res.status).toBe(400);
      const cookies2 = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
      const clearCookie2 = cookies2?.find((c: string) => c.includes('integration_oauth_state'));
      expect(clearCookie2).toBeDefined();
      expect(clearCookie2).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
  });

  describe('GET /:provider/callback — provider allowlist unchanged (AC-7)', () => {
    it('returns 400 for invalid provider before any cookie logic', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await request(app)
        .get('/api/v1/integrations/invalid-provider/callback?code=abc&state=x');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Invalid provider');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });
  });
});
