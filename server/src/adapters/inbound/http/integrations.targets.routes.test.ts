// Finish-setup flow: target discovery, per-provider config validation, the
// ClickUp/Asana providers and the Jira auto-resolve in the OAuth callback.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { request } from '../../../__tests__/supertestClient.js';
import { createIntegrationsRoutes, type IntegrationsRouteDeps } from './integrations.routes.js';
import type { Integration } from '../../../domain/integration/ports/IntegrationRepo.js';
import type { IntegrationOAuthProvider } from '../../../services/integrations/oauthExchange.js';

const SECRET = 'test-hmac-secret-for-oauth-state';

// ---- Fake provider API. Production https URLs are rewritten to this server. ----
const seen: Array<{ url: string; auth?: string }> = [];
let api: http.Server;
let apiPort = 0;
const routes: Record<string, unknown> = {
  'api.github.com/user/repos': [
    { name: 'web', owner: { login: 'acme' }, has_issues: true },
    { name: 'noissues', owner: { login: 'acme' }, has_issues: false },
  ],
  'api.linear.app/graphql': { data: { teams: { nodes: [{ id: 'team-1', name: 'Core', key: 'COR' }] } } },
  'api.atlassian.com/oauth/token/accessible-resources': [
    { id: 'cloud-1', name: 'Acme', url: 'https://acme.atlassian.net' },
    { id: 'cloud-2', name: 'Beta', url: 'https://beta.atlassian.net' },
  ],
  'api.atlassian.com/ex/jira/cloud-1/rest/api/3/project/search': { values: [{ key: 'WEB', name: 'Website' }] },
  'api.atlassian.com/ex/jira/cloud-2/rest/api/3/project/search': { values: [{ key: 'OPS', name: 'Ops' }] },
  'api.clickup.com/api/v2/team': { teams: [{ id: 't1', name: 'Team' }] },
  'api.clickup.com/api/v2/team/t1/space': { spaces: [{ id: 's1', name: 'Space' }] },
  'api.clickup.com/api/v2/space/s1/list': { lists: [{ id: 'l1', name: 'Bugs' }] },
  'app.asana.com/api/1.0/workspaces': { data: [{ gid: '111', name: 'WS' }] },
  'app.asana.com/api/1.0/projects': { data: [{ gid: '222', name: 'Proj' }] },
  'slack.com/api/conversations.list': {
    ok: true,
    channels: [
      { id: 'C222', name: 'random', is_member: false },
      { id: 'C111', name: 'feedback', is_member: true },
      { id: 'C333', name: 'old', is_member: true, is_archived: true },
    ],
    response_metadata: { next_cursor: '' },
  },
};

// Fake token endpoint for the callback tests.
let idp: http.Server;
let idpPort = 0;

beforeAll(async () => {
  api = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push({ url: `${u.pathname}${u.search}`, auth: req.headers.authorization });
    const key = u.pathname.slice(1);
    res.setHeader('content-type', 'application/json');
    if (key in routes) res.end(JSON.stringify(routes[key]));
    else { res.statusCode = 404; res.end('{}'); }
  });
  idp = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }));
  });
  await Promise.all([
    new Promise<void>((r) => api.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => idp.listen(0, '127.0.0.1', r)),
  ]);
  apiPort = (api.address() as AddressInfo).port;
  idpPort = (idp.address() as AddressInfo).port;
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => api.close(() => r())),
    new Promise<void>((r) => idp.close(() => r())),
  ]);
});

const fakeSafeFetch = ((url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  expect(u.protocol).toBe('https:'); // production code must only ever ask for https URLs
  return fetch(`http://127.0.0.1:${apiPort}/${u.host}${u.pathname}${u.search}`, init);
}) as unknown as IntegrationsRouteDeps['safeFetch'];

const FAKE_EGRESS = {
  allowHttp: true,
  allowPrivateForTests: true,
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
};

function fakeOAuth(): IntegrationOAuthProvider {
  return {
    clientId: 'client-1',
    clientSecret: 'client-secret-1',
    authorizeUrl: 'https://idp.example/authorize',
    tokenUrl: `http://idp.test:${idpPort}/token`,
    scopes: [],
    scopeSeparator: ' ',
    tokenRequest: 'form',
  };
}

function admin(role = 'admin') {
  return (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    (req as any).user = { userId: 'u1', orgId: 'org-123', role, email: 'a@b.com' };
    next();
  };
}

function integrationOf(provider: string, config: Record<string, unknown> = {}, over: Partial<Integration> = {}): Integration {
  return {
    id: 'int-1', orgId: 'org-123', provider, accessToken: 'secret-token-xyz', refreshToken: 'rt',
    config, enabled: true, createdAt: '2024-01-01T00:00:00Z', ...over,
  };
}

function depsFor(existing: Integration | null, extra: Partial<IntegrationsRouteDeps> = {}): IntegrationsRouteDeps {
  return {
    authMiddleware: admin(),
    integrationRepo: {
      findByOrgAndProvider: vi.fn().mockResolvedValue(existing),
      listByOrg: vi.fn().mockResolvedValue(existing ? [existing] : []),
      upsert: vi.fn().mockImplementation(async (_o: string, p: string, d: Partial<Integration>) => ({ ...integrationOf(p), ...d })),
      delete: vi.fn().mockResolvedValue(true),
    },
    oauthStateSecret: SECRET,
    oauthProviders: {},
    callbackBaseUrl: 'https://app.example',
    egress: FAKE_EGRESS,
    safeFetch: fakeSafeFetch,
    ...extra,
  };
}

function app(deps: IntegrationsRouteDeps): express.Express {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/v1/integrations', createIntegrationsRoutes(deps));
  return a;
}

function stateCookie(provider: string, nonce: string): string {
  const exp = Date.now() + 600_000;
  const sig = createHmac('sha256', SECRET).update(`${nonce}.org-123.${provider}.u1.${exp}`).digest('hex');
  return `integration_oauth_state=${encodeURIComponent(JSON.stringify({ state: nonce, orgId: 'org-123', provider, uid: 'u1', exp, sig }))}`;
}

describe('GET /:provider/targets', () => {
  const cases: Array<[string, unknown, string]> = [
    ['github', [{ id: 'acme/web', label: 'acme/web', config: { owner: 'acme', repo: 'web' } }], 'Bearer secret-token-xyz'],
    ['linear', [{ id: 'team-1', label: 'Core (COR)', config: { teamId: 'team-1' } }], 'Bearer secret-token-xyz'],
    ['jira', [
      { id: 'cloud-1:WEB', label: 'Acme / WEB — Website', config: { cloudId: 'cloud-1', projectKey: 'WEB', siteUrl: 'https://acme.atlassian.net' } },
      { id: 'cloud-2:OPS', label: 'Beta / OPS — Ops', config: { cloudId: 'cloud-2', projectKey: 'OPS', siteUrl: 'https://beta.atlassian.net' } },
    ], 'Bearer secret-token-xyz'],
    ['clickup', [{ id: 'l1', label: 'Team / Space / Bugs', config: { listId: 'l1' } }], 'secret-token-xyz'],
    ['asana', [{ id: '222', label: 'WS / Proj', config: { projectGid: '222', workspaceGid: '111' } }], 'Bearer secret-token-xyz'],
    ['slack', [
      { id: 'C111', label: '#feedback', config: { channelId: 'C111', channelName: 'feedback' } },
      { id: 'C222', label: '#random (invite the bot first)', config: { channelId: 'C222', channelName: 'random' } },
    ], 'Bearer secret-token-xyz'],
  ];

  it.each(cases)('%s: parses the provider payload, sends the right auth, never leaks the token', async (provider, expected, auth) => {
    seen.length = 0;
    const res = await request(app(depsFor(integrationOf(provider)))).get(`/api/v1/integrations/${provider}/targets`);
    expect(res.status).toBe(200);
    expect(res.body.targets).toEqual(expected);
    expect(JSON.stringify(res.body)).not.toContain('secret-token-xyz');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.auth === auth)).toBe(true);
  });

  it('404 when not connected, 400 for a provider without targets, 409 when disabled', async () => {
    expect((await request(app(depsFor(null))).get('/api/v1/integrations/github/targets')).status).toBe(404);
    expect((await request(app(depsFor(integrationOf('mystery')))).get('/api/v1/integrations/mystery/targets')).status).toBe(400);
    const disabled = await request(app(depsFor(integrationOf('github', {}, { enabled: false })))).get('/api/v1/integrations/github/targets');
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('INTEGRATION_NOT_CONNECTED');
  });

  it('provider failure → 502 PROVIDER_ERROR without echoing the token; a 401 hints to reconnect', async () => {
    const boom = await request(app(depsFor(integrationOf('github'), {
      safeFetch: (async () => { throw new Error('boom secret-token-xyz'); }) as never,
    }))).get('/api/v1/integrations/github/targets');
    expect(boom.status).toBe(502);
    expect(boom.body.error.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(boom.body)).not.toContain('secret-token-xyz');

    const unauth = await request(app(depsFor(integrationOf('linear'), {
      safeFetch: (async () => new Response('{}', { status: 401 })) as never,
    }))).get('/api/v1/integrations/linear/targets');
    expect(unauth.status).toBe(502);
    expect(unauth.body.error.message).toMatch(/Reconnect/);
  });

  it('is admin-only (targets and PATCH)', async () => {
    const deps = depsFor(integrationOf('github'), { authMiddleware: admin('viewer') });
    expect((await request(app(deps)).get('/api/v1/integrations/github/targets')).status).toBe(403);
    expect((await request(app(deps)).patch('/api/v1/integrations/github').send({ config: { owner: 'a', repo: 'b' } })).status).toBe(403);
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });
});

describe('PATCH /:provider', () => {
  it('stores a validated config merged over the existing one and carries credentials through', async () => {
    const deps = depsFor(integrationOf('github', { scope: 'repo' }, { tokenExpiresAt: '2030-01-01T00:00:00Z' }));
    const res = await request(app(deps)).patch('/api/v1/integrations/github').send({ config: { owner: 'acme', repo: 'web' } });
    expect(res.status).toBe(200);
    expect(deps.integrationRepo.upsert).toHaveBeenCalledWith('org-123', 'github', expect.objectContaining({
      accessToken: 'secret-token-xyz',
      refreshToken: 'rt',
      tokenExpiresAt: '2030-01-01T00:00:00Z',
      enabled: true,
      config: { scope: 'repo', owner: 'acme', repo: 'web' },
    }));
    expect(res.body.integration.config).toEqual({ scope: 'repo', owner: 'acme', repo: 'web' });
    expect(JSON.stringify(res.body)).not.toContain('secret-token-xyz');
  });

  it.each([
    ['github', { owner: 'acme' }],
    ['github', { owner: 'a/b', repo: 'c' }],
    ['github', { owner: 'a', repo: 'b', extra: 1 }],
    ['linear', {}],
    ['jira', { cloudId: 'c', projectKey: 'bad key' }],
    ['jira', { cloudId: 'c', projectKey: 'WEB', siteUrl: 'http://acme.atlassian.net' }],
    ['clickup', { listId: '../x' }],
    ['asana', { projectGid: 'abc' }],
    ['slack', {}],
    ['slack', { channelId: 'general' }],
    ['slack', { channelId: 'C123', minSeverity: 'urgent' }],
    ['slack', { channelId: 'C123', notifyOnNew: 'yes' }],
    ['slack', { channelId: 'C123', webhook: 'x' }],
  ])('%s rejects invalid config %j with 400 VALIDATION', async (provider, config) => {
    const deps = depsFor(integrationOf(provider));
    const res = await request(app(deps)).patch(`/api/v1/integrations/${provider}`).send({ config });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(deps.integrationRepo.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['jira', { cloudId: 'c1', projectKey: 'WEB', issueType: 'Bug', siteUrl: 'https://acme.atlassian.net' }],
    ['linear', { teamId: 't' }],
    ['clickup', { listId: '901' }],
    ['asana', { projectGid: '222', workspaceGid: '111' }],
    ['slack', { channelId: 'C0123ABCD', channelName: 'feedback', notifyOnNew: true, minSeverity: 'critical' }],
  ])('%s accepts a valid config', async (provider, config) => {
    expect((await request(app(depsFor(integrationOf(provider)))).patch(`/api/v1/integrations/${provider}`).send({ config })).status).toBe(200);
  });

  it('404 when not connected; 400 for a missing config', async () => {
    expect((await request(app(depsFor(null))).patch('/api/v1/integrations/github').send({ config: { owner: 'a', repo: 'b' } })).status).toBe(404);
    expect((await request(app(depsFor(integrationOf('github')))).patch('/api/v1/integrations/github').send({})).status).toBe(400);
  });
});

describe('PATCH /slack', () => {
  it('stores channel + notify settings, defaulting notifyOnNew=false and minSeverity=major', async () => {
    const deps = depsFor(integrationOf('slack', { team: 'T1' }));
    const res = await request(app(deps)).patch('/api/v1/integrations/slack').send({ config: { channelId: 'C0123ABCD', channelName: 'feedback' } });
    expect(res.status).toBe(200);
    expect(deps.integrationRepo.upsert).toHaveBeenCalledWith('org-123', 'slack', expect.objectContaining({
      config: { team: 'T1', channelId: 'C0123ABCD', channelName: 'feedback', notifyOnNew: false, minSeverity: 'major' },
    }));
  });
});

describe('ClickUp / Asana providers', () => {
  it.each(['clickup', 'asana'])('%s can start OAuth and accept a pasted token', async (p) => {
    const deps = depsFor(null, { oauthProviders: { [p]: { ...fakeOAuth(), authorizeUrl: `https://${p}.example/authorize` } } });
    const c = await request(app(deps)).post(`/api/v1/integrations/${p}/connect`).send({});
    expect(c.status).toBe(200);
    expect(c.body.redirectUrl).toContain(`https://${p}.example/authorize`);
    const t = await request(app(depsFor(null))).post(`/api/v1/integrations/${p}/connect`).send({ accessToken: 'x', config: { listId: '1' } });
    expect(t.status).toBe(201);
  });
});

describe('callback', () => {
  async function runCallback(provider: string, deps: IntegrationsRouteDeps) {
    const nonce = '9'.repeat(32);
    return request(app(deps))
      .get(`/api/v1/integrations/${provider}/callback?code=c&state=${nonce}`)
      .set('Cookie', stateCookie(provider, nonce));
  }
  const upsertConfig = (deps: IntegrationsRouteDeps) =>
    (deps.integrationRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![2].config as Record<string, unknown>;

  it('Jira with exactly one accessible site stores cloudId + siteUrl; with several (or garbage) it does not', async () => {
    const run = async (resources: unknown) => {
      const deps = depsFor(null, {
        oauthProviders: { jira: fakeOAuth() },
        safeFetch: (async () => new Response(JSON.stringify(resources), { status: 200 })) as never,
      });
      const res = await runCallback('jira', deps);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://app.example/integrations?connected=jira');
      return upsertConfig(deps);
    };
    expect(await run([{ id: 'cloud-9', url: 'https://x.atlassian.net' }])).toMatchObject({ cloudId: 'cloud-9', siteUrl: 'https://x.atlassian.net' });
    expect(await run([{ id: 'a' }, { id: 'b' }])).not.toHaveProperty('cloudId');
    expect(await run('not-an-array')).not.toHaveProperty('cloudId');
  });

  it('a reconnect keeps the previously chosen target', async () => {
    const deps = depsFor(integrationOf('github', { owner: 'acme', repo: 'web' }), { oauthProviders: { github: fakeOAuth() } });
    const res = await runCallback('github', deps);
    expect(res.status).toBe(302);
    expect(upsertConfig(deps)).toMatchObject({ owner: 'acme', repo: 'web' });
  });

  it('redirect carries no token', async () => {
    const deps = depsFor(null, { oauthProviders: { linear: fakeOAuth() } });
    const res = await runCallback('linear', deps);
    expect(res.headers.location).toBe('https://app.example/integrations?connected=linear');
    expect(res.headers.location).not.toContain('at-new');
  });

  it('the list DTO never exposes the stored refresh material', async () => {
    const deps = depsFor(integrationOf('github', { owner: 'a', repo: 'b', tokenEndpoint: 'https://x/token', clientId: 'id', clientSecret: 'shh' }));
    const res = await request(app(deps)).get('/api/v1/integrations');
    expect(res.status).toBe(200);
    const cfg = res.body.integrations[0].config;
    expect(cfg).not.toHaveProperty('clientSecret');
    expect(cfg).not.toHaveProperty('tokenEndpoint');
    expect(JSON.stringify(res.body)).not.toContain('shh');
  });
});
