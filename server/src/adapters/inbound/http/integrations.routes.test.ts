import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { request } from '../../../__tests__/supertestClient.js';
import { createHmac } from 'node:crypto';
import { createIntegrationsRoutes, type IntegrationsRouteDeps } from './integrations.routes.js';
import type { IntegrationRepo, Integration } from '../../../domain/integration/ports/IntegrationRepo.js';
import type { IntegrationOAuthProvider } from '../../../services/integrations/oauthExchange.js';

// ---- Fake provider token endpoint (the only network the tests touch) ----
const IDP_HOST = 'idp.test';
let idp: http.Server;
let idpPort = 0;
const idpSeen: Array<{ method?: string; contentType?: string; body: Record<string, string> }> = [];

beforeAll(async () => {
  idp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = Object.fromEntries(new URLSearchParams(raw));
      idpSeen.push({ method: req.method, contentType: String(req.headers['content-type']), body });
      res.setHeader('content-type', 'application/json');
      if (body.code === 'bad-code') {
        res.end(JSON.stringify({ ok: false, error: 'invalid_code' }));
      } else if (body.code === 'http-500') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'server_error', secret_detail: 'do-not-leak' }));
      } else if (body.code === 'no-token') {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.end(JSON.stringify({
          ok: true,
          access_token: `at-for-${body.code}`,
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: 'chat:write',
          team: { name: 'Acme' },
        }));
      }
    });
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  idpPort = (idp.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => idp.close(() => r()));
});

function fakeProvider(): IntegrationOAuthProvider {
  return {
    clientId: 'client-1',
    clientSecret: 'client-secret-1',
    authorizeUrl: 'https://slack.example/oauth/authorize',
    tokenUrl: `http://${IDP_HOST}:${idpPort}/token`,
    scopes: ['chat:write'],
    scopeSeparator: ',',
    tokenRequest: 'form',
  };
}
const FAKE_EGRESS = {
  allowHttp: true,
  allowPrivateForTests: true,
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
};

const TEST_SECRET = 'test-hmac-secret-for-oauth-state';

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
    oauthStateSecret: TEST_SECRET,
    oauthProviders: { slack: fakeProvider(), jira: { ...fakeProvider() } },
    callbackBaseUrl: 'https://app.example',
    egress: FAKE_EGRESS,
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
function buildStateCookie(
  input: { state: string; orgId: string; provider: string; uid?: string; exp?: number },
  secret: string = TEST_SECRET,
): string {
  const payload = { uid: 'u1', exp: Date.now() + 600_000, ...input };
  const sig = createHmac('sha256', secret)
    .update(`${payload.state}.${payload.orgId}.${payload.provider}.${payload.uid}.${payload.exp}`)
    .digest('hex');
  return `integration_oauth_state=${encodeURIComponent(JSON.stringify({ ...payload, sig }))}`;
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
        expect.objectContaining({ accessToken: 'at-for-abc123', refreshToken: 'rt-1' }),
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

  describe('HMAC signature verification — new tests', () => {
    it('AC-1: connect cookie contains a valid sig field', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const res = await request(app)
        .post('/api/v1/integrations/slack/connect')
        .send({});

      expect(res.status).toBe(200);
      const cookies = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
      const stateCookieHeader = cookies.find((c: string) => c.includes('integration_oauth_state'))!;
      const match = stateCookieHeader.match(/integration_oauth_state=([^;]+)/)!;
      const parsed = JSON.parse(decodeURIComponent(match[1]));

      // sig should be a 64-char hex string (SHA-256 = 32 bytes = 64 hex chars)
      expect(parsed.sig).toMatch(/^[0-9a-f]{64}$/);

      // Recompute and verify
      const expectedSig = createHmac('sha256', TEST_SECRET)
        .update(`${parsed.state}.${parsed.orgId}.${parsed.provider}.${parsed.uid}.${parsed.exp}`)
        .digest('hex');
      expect(parsed.sig).toBe(expectedSig);
    });

    it('AC-3: tampered orgId with valid state is rejected 400', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'd'.repeat(32);
      // Sign with the legitimate orgId
      const legitimateSig = createHmac('sha256', TEST_SECRET)
        .update(`${nonce}.org-123.slack`)
        .digest('hex');

      // But put a DIFFERENT orgId in the cookie (attacker tampering)
      const tampered = { state: nonce, orgId: 'org-VICTIM', provider: 'slack', sig: legitimateSig };
      const cookieStr = `integration_oauth_state=${encodeURIComponent(JSON.stringify(tampered))}`;

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', cookieStr);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('OAuth state signature invalid');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('AC-4: missing sig field rejected 400', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'e'.repeat(32);
      // Cookie WITHOUT sig (simulates pre-fix cookie)
      const unsigned = { state: nonce, orgId: 'org-123', provider: 'slack' };
      const cookieStr = `integration_oauth_state=${encodeURIComponent(JSON.stringify(unsigned))}`;

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', cookieStr);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('OAuth state signature invalid');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('AC-5: altered sig (same length) rejected 400', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = 'f'.repeat(32);
      const validSig = createHmac('sha256', TEST_SECRET)
        .update(`${nonce}.org-123.slack`)
        .digest('hex');

      // Flip one hex char in sig
      const alteredSig = validSig[0] === 'a'
        ? 'b' + validSig.slice(1)
        : 'a' + validSig.slice(1);

      const tampered = { state: nonce, orgId: 'org-123', provider: 'slack', sig: alteredSig };
      const cookieStr = `integration_oauth_state=${encodeURIComponent(JSON.stringify(tampered))}`;

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', cookieStr);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('OAuth state signature invalid');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('AC-6: sig computed with WRONG secret rejected 400', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = '1'.repeat(32);
      // Sign with a different secret (simulates secret rotation)
      const wrongSecret = 'totally-different-secret';
      const wrongSig = createHmac('sha256', wrongSecret)
        .update(`${nonce}.org-123.slack`)
        .digest('hex');

      const payload = { state: nonce, orgId: 'org-123', provider: 'slack', sig: wrongSig };
      const cookieStr = `integration_oauth_state=${encodeURIComponent(JSON.stringify(payload))}`;

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', cookieStr);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('OAuth state signature invalid');
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('AC-2: valid signed cookie allows upsert with verified orgId', async () => {
      const deps = makeDeps();
      const app = makeApp(deps);

      const nonce = '2'.repeat(32);
      const cookiePayload = { state: nonce, orgId: 'org-123', provider: 'slack' };

      const res = await request(app)
        .get(`/api/v1/integrations/slack/callback?code=xyz&state=${nonce}`)
        .set('Cookie', buildStateCookie(cookiePayload));

      expect(res.status).toBe(200);
      expect(deps.integrationRepo.upsert).toHaveBeenCalledWith(
        'org-123',
        'slack',
        expect.objectContaining({ accessToken: 'at-for-xyz' }),
      );
    });
  });

  describe('PP-21: expiry, user binding, Secure', () => {
    it('rejects a state cookie whose signed expiry has passed (even if the browser still sent it)', async () => {
      const deps = makeDeps();
      const nonce = 'c'.repeat(32);
      const res = await request(makeApp(deps))
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie({ state: nonce, orgId: 'org-123', provider: 'slack', exp: Date.now() - 1 }));
      expect(res.status).toBe(400);
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('rejects a cookie minted for a different admin (user binding)', async () => {
      const deps = makeDeps();
      const nonce = 'd'.repeat(32);
      const res = await request(makeApp(deps))
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie({ state: nonce, orgId: 'org-123', provider: 'slack', uid: 'someone-else' }));
      expect(res.status).toBe(400);
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('rejects a tampered expiry (signature covers exp and uid)', async () => {
      const deps = makeDeps();
      const nonce = 'e'.repeat(32);
      const good = decodeURIComponent(buildStateCookie({ state: nonce, orgId: 'org-123', provider: 'slack' }).split('=')[1]!);
      const forged = { ...JSON.parse(good), exp: Date.now() + 10 * 365 * 24 * 3600_000 };
      const res = await request(makeApp(deps))
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', `integration_oauth_state=${encodeURIComponent(JSON.stringify(forged))}`);
      expect(res.status).toBe(400);
      expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
    });

    it('requires an authenticated org admin on the callback', async () => {
      const deps = makeDeps({ authMiddleware: (_req, res) => void res.status(401).json({}) });
      const nonce = 'f'.repeat(32);
      const res = await request(makeApp(deps))
        .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
        .set('Cookie', buildStateCookie({ state: nonce, orgId: 'org-123', provider: 'slack' }));
      expect(res.status).toBe(401);
    });

    it('sets the state cookie Secure even outside production', async () => {
      const res = await request(makeApp(makeDeps())).post('/api/v1/integrations/slack/connect').send({});
      const set = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]);
      expect(set.find((c) => c.includes('integration_oauth_state'))).toMatch(/;\s*Secure/i);
    });
  });
});


describe('PP-21 — real OAuth code exchange', () => {
  function stateCookieFor(nonce: string, provider = 'slack'): string {
    return buildStateCookie({ state: nonce, orgId: 'org-123', provider });
  }

  it('connect returns the provider authorize URL (client id, redirect_uri, state, scope) — no placeholder host', async () => {
    const res = await request(makeApp(makeDeps())).post('/api/v1/integrations/slack/connect').send({});
    expect(res.status).toBe(200);
    const url = new URL(res.body.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://slack.example/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/api/v1/integrations/slack/callback');
    expect(url.searchParams.get('scope')).toBe('chat:write');
    expect(res.body.redirectUrl).not.toContain('PLACEHOLDER');
    expect(res.body.redirectUrl).not.toContain('client-secret-1');
  });

  it('state cookie is Secure by default and only drops Secure under COOKIE_INSECURE', async () => {
    const cookieOf = async (cookieInsecure: boolean) => {
      const res = await request(makeApp(makeDeps({ cookieInsecure }))).post('/api/v1/integrations/slack/connect').send({});
      const all = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
      return all.find((c) => c.startsWith('integration_oauth_state='))!;
    };
    expect(await cookieOf(false)).toMatch(/;\s*Secure/i);
    expect(await cookieOf(true)).not.toMatch(/Secure/i);
  });

  it('unconfigured provider answers 501 on connect and callback, and never stores a token', async () => {
    const deps = makeDeps({ oauthProviders: {} });
    const app = makeApp(deps);
    const c = await request(app).post('/api/v1/integrations/slack/connect').send({});
    expect(c.status).toBe(501);
    expect(c.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    const nonce = 'd'.repeat(32);
    const cb = await request(app)
      .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
      .set('Cookie', stateCookieFor(nonce));
    expect(cb.status).toBe(501);
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });

  it('exchanges the code at the token endpoint with client credentials and stores the returned tokens', async () => {
    idpSeen.length = 0;
    const deps = makeDeps();
    const nonce = 'e'.repeat(32);
    const res = await request(makeApp(deps))
      .get(`/api/v1/integrations/slack/callback?code=the-code&state=${nonce}`)
      .set('Cookie', stateCookieFor(nonce));
    expect(res.status).toBe(200);
    expect(idpSeen).toHaveLength(1);
    expect(idpSeen[0]!.method).toBe('POST');
    expect(idpSeen[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'client-1',
      client_secret: 'client-secret-1',
      redirect_uri: 'https://app.example/api/v1/integrations/slack/callback',
    });
    const [org, provider, data] = (deps.integrationRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(org).toBe('org-123');
    expect(provider).toBe('slack');
    expect(data.accessToken).toBe('at-for-the-code');
    expect(data.tokenExpiresAt).toMatch(/^\d{4}-/);
    expect(data.config).toEqual({ scope: 'chat:write', workspace: 'Acme' });
    // The response never contains the token.
    expect(JSON.stringify(res.body)).not.toContain('at-for-the-code');
  });

  it.each(['bad-code', 'http-500', 'no-token'])('provider failure (%s) → 502, nothing stored, provider body not echoed', async (code) => {
    const deps = makeDeps();
    const nonce = 'f'.repeat(32);
    const res = await request(makeApp(deps))
      .get(`/api/v1/integrations/slack/callback?code=${code}&state=${nonce}`)
      .set('Cookie', stateCookieFor(nonce));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OAUTH_EXCHANGE_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('do-not-leak');
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });

  it('an unreachable / SSRF-blocked token endpoint → 502 (egress guard enforced)', async () => {
    const deps = makeDeps({
      oauthProviders: { slack: { ...fakeProvider(), tokenUrl: 'http://169.254.169.254/token' } },
    });
    const nonce = '1'.repeat(32);
    const res = await request(makeApp(deps))
      .get(`/api/v1/integrations/slack/callback?code=abc&state=${nonce}`)
      .set('Cookie', stateCookieFor(nonce));
    expect(res.status).toBe(502);
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects an expired state (signed exp), a state minted for another user, and provider-reported errors', async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const n = '2'.repeat(32);
    const expired = await request(app)
      .get(`/api/v1/integrations/slack/callback?code=abc&state=${n}`)
      .set('Cookie', buildStateCookie({ state: n, orgId: 'org-123', provider: 'slack', exp: Date.now() - 1000 }));
    expect(expired.status).toBe(400);
    const otherUser = await request(app)
      .get(`/api/v1/integrations/slack/callback?code=abc&state=${n}`)
      .set('Cookie', buildStateCookie({ state: n, orgId: 'org-123', provider: 'slack', uid: 'someone-else' }));
    expect(otherUser.status).toBe(400);
    const denied = await request(app)
      .get(`/api/v1/integrations/slack/callback?error=access_denied&state=${n}`)
      .set('Cookie', stateCookieFor(n));
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('OAUTH_DENIED');
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });
});
