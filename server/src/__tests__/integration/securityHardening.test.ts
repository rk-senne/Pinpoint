// Integration test (real Postgres, real composition root): PP-15 / PP-20 / PP-21 / PP-22.
//
//  PP-15  session-bound CSRF end to end; org switch keeps the session start.
//  PP-20  per-board + per-IP quotas and IP-hash vote dedupe on the public board.
//  PP-21  integration tokens are stored encrypted (SecretBox) at rest.
//  PP-22  append-only audit trail: auth events, exports, sharing, boards,
//         portals, integrations, invitations, org switch; request context;
//         new audit-log filters; UPDATE/DELETE blocked by the DB trigger.
//
// Skips gracefully when no Postgres test DB is reachable.

import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveApp } from './helpers/liveApp.js';
import { JwtTokenIssuer } from '../../adapters/outbound/jwt/JwtTokenIssuer.js';
import { createPremiumRoutes } from '../../adapters/inbound/http/premium.routes.js';
import { __resetWidgetRateLimitMemory } from '../../middleware/widgetRateLimit.js';
import { PgIntegrationRepo } from '../../adapters/outbound/postgres/PgIntegrationRepo.js';
import { SecretBox, deriveKey } from '../../services/secretBox.js';

let live: LiveApp | null = null;
let skip: string | null = null;
const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
const PASSWORD = 'Str0ng-Test-Passw0rd-xyz!';
const issuer = new JwtTokenIssuer({ secret: process.env.JWT_SECRET || 'dev-secret', accessTtl: '1h', graceWindowSeconds: 60 } as never);

beforeAll(async () => {
  const booted = await bootLiveApp();
  if ('skip' in booted) skip = booted.skip;
  else live = booted;
});
afterAll(async () => {
  await live?.cleanup();
});

/** Audit rows are written after the response is flushed; poll briefly. */
async function auditRows(where: Record<string, unknown>, expected = 1): Promise<Array<Record<string, any>>> {
  for (let i = 0; i < 40; i++) {
    const rows = await live!.db('audit_logs').where(where).orderBy('created_at', 'asc');
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return live!.db('audit_logs').where(where);
}

interface Account { id: string; email: string; token: string; cookies: string[]; csrf: string; orgId: string }
const createdUsers: string[] = [];
async function registerAndLogin(): Promise<Account> {
  const email = `pp-${randomUUID().slice(0, 8)}@hardening.example.test`;
  const reg = await request(live!.app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Pp Tester' });
  expect(reg.status).toBeLessThan(300);
  await live!.db('users').where({ email }).update({ verified: true });
  const login = await request(live!.app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!);
  const user = await live!.db('users').where({ email }).first('id');
  createdUsers.push(user.id);
  const claims = issuer.verify(login.body.token);
  return { id: user.id, email, token: login.body.token, cookies, csrf: login.body.csrfToken, orgId: claims.orgId };
}

describe('PP-15 session hardening (live app)', () => {
  it('cookie session needs the session-bound CSRF token: a tossed matching pair is rejected, the real one works', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await registerAndLogin();
    const tossed = await request(live!.app)
      .put('/api/v1/users/me/notifications')
      .set('Cookie', [a.cookies[0]!, 'fl_csrf=attacker'])
      .set('X-CSRF-Token', 'attacker')
      .send({});
    expect(tossed.status).toBe(403);
    expect(tossed.body.error.code).toBe('CSRF_INVALID');

    const real = await request(live!.app)
      .put('/api/v1/users/me/notifications')
      .set('Cookie', a.cookies)
      .set('X-CSRF-Token', a.csrf)
      .send({});
    expect(real.status).not.toBe(403);

    // A CSRF token minted for ANOTHER session of a different user is not accepted either.
    const b = await registerAndLogin();
    const crossSession = await request(live!.app)
      .put('/api/v1/users/me/notifications')
      .set('Cookie', [a.cookies[0]!, `fl_csrf=${b.csrf}`])
      .set('X-CSRF-Token', b.csrf)
      .send({});
    expect(crossSession.status).toBe(403);
  });

  it('login mints a bound token (nonce.mac) and refresh re-mints one that matches the refreshed session', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await registerAndLogin();
    expect(a.csrf).toMatch(/^[0-9a-f]{48}\.[0-9a-f]{64}$/);
    const refreshed = await request(live!.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', a.cookies)
      .set('X-CSRF-Token', a.csrf)
      .send({});
    expect(refreshed.status).toBe(200);
    const sc = ([] as string[]).concat(refreshed.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!);
    const sessionCookie = sc.find((c) => c.startsWith('fl_session='))!;
    const next = await request(live!.app)
      .put('/api/v1/users/me/notifications')
      .set('Cookie', [sessionCookie, `fl_csrf=${refreshed.body.csrfToken}`])
      .set('X-CSRF-Token', refreshed.body.csrfToken)
      .send({});
    expect(next.status).not.toBe(403);
  });

  it('org switch keeps the original sessionStart (no absolute-lifetime reset)', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await registerAndLogin();
    const before = issuer.verify(a.token);
    const orgB = randomUUID();
    await live!.db('organizations').insert({ id: orgB, name: 'pp15-b', slug: `pp15-${orgB.slice(0, 10)}` });
    await live!.db('memberships').insert({ org_id: orgB, user_id: a.id, role: 'member' });
    const res = await request(live!.app).post('/api/v1/org/switch').set('Authorization', `Bearer ${a.token}`).send({ orgId: orgB });
    expect(res.status).toBe(200);
    const after = issuer.verify(res.body.token);
    expect(after.orgId).toBe(orgB);
    expect(after.sessionStart).toBe(before.sessionStart);
    await live!.db('memberships').where({ org_id: orgB }).del();
    await live!.db('organizations').where({ id: orgB }).del();
  });
});

describe('PP-22 audit trail (live app)', () => {
  it('records failed login for an unknown address without a tenant, with ip / user-agent / request id, and never the raw e-mail', async (ctx) => {
    if (skip) return ctx.skip();
    const email = `nobody-${randomUUID().slice(0, 8)}@hardening.example.test`;
    const res = await request(live!.app)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'pp22-test-agent/1.0')
      .send({ email, password: 'wrong-password-123' });
    expect(res.status).toBe(401);
    const rid = String(res.headers['x-request-id']);
    const [row] = await auditRows({ request_id: rid });
    expect(row).toBeDefined();
    expect(row!.action).toBe('auth.login_failed');
    expect(row!.org_id).toBeNull();
    expect(row!.actor_id).toBeNull();
    expect(row!.user_agent).toBe('pp22-test-agent/1.0');
    expect(row!.ip_address).toBeTruthy();
    expect(JSON.stringify(row!.metadata)).not.toContain(email);
    expect(row!.metadata.emailHash).toBe(sha(email).slice(0, 16));
  });

  it('records login success/failure for a real user, logout, password reset request + completion, and e-mail change request', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await registerAndLogin();
    const [ok] = await auditRows({ actor_id: a.id, action: 'auth.login_succeeded' });
    expect(ok).toBeDefined();
    expect(ok!.org_id).toBe(a.orgId);

    const bad = await request(live!.app).post('/api/v1/auth/login').send({ email: a.email, password: 'definitely-wrong-1' });
    expect(bad.status).toBe(401);
    const [failed] = await auditRows({ actor_id: a.id, action: 'auth.login_failed' });
    expect(failed!.org_id).toBe(a.orgId);

    // e-mail change request (Bearer ⇒ CSRF-exempt)
    const newEmail = `chg-${randomUUID().slice(0, 8)}@hardening.example.test`;
    const chg = await request(live!.app)
      .put('/api/v1/users/me')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: newEmail, currentPassword: PASSWORD });
    expect(chg.status).toBe(200);
    const [emailRow] = await auditRows({ actor_id: a.id, action: 'auth.email_change_requested' });
    expect(emailRow).toBeDefined();
    expect(JSON.stringify(emailRow!.metadata)).not.toContain(newEmail);
    expect(emailRow!.metadata.emailDomain).toBe('hardening.example.test');

    // password reset: request then complete with a token we plant (the real one is only e-mailed)
    const rr = await request(live!.app).post('/api/v1/auth/reset-password').send({ email: a.email });
    expect(rr.status).toBeLessThan(300);
    expect((await auditRows({ actor_id: a.id, action: 'auth.password_reset_requested' }))).toHaveLength(1);
    const raw = randomUUID() + randomUUID();
    await live!.db('auth_tokens').insert({ user_id: a.id, kind: 'reset_password', token_hash: sha(raw), expires_at: new Date(Date.now() + 3_600_000), used: false });
    const done = await request(live!.app).post(`/api/v1/auth/reset-password/${raw}`).send({ password: `${PASSWORD}-new` });
    expect(done.status).toBeLessThan(300);
    expect((await auditRows({ actor_id: a.id, action: 'auth.password_reset_completed' }))).toHaveLength(1);

    // logout needs a live session: log in again with the new password
    const login2 = await request(live!.app).post('/api/v1/auth/login').send({ email: a.email, password: `${PASSWORD}-new` });
    expect(login2.status).toBe(200);
    const out = await request(live!.app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${login2.body.token}`).send({});
    expect(out.status).toBe(200);
    expect((await auditRows({ actor_id: a.id, action: 'auth.logout' }))).toHaveLength(1);
  });

  it('records sharing, export, board, portal, integration, invitation and org-switch mutations with actor + org + request context', async (ctx) => {
    if (skip) return ctx.skip();
    const { orgId, actors } = await live!.seedOrg(['owner']);
    const owner = actors.owner!;
    const projectId = await live!.seedProject(orgId, owner.id);
    const auth = { Authorization: `Bearer ${await owner.token()}` };

    const share = await request(live!.app).post(`/api/v1/projects/${projectId}/share`).set(auth).send({ allowFeedback: true });
    expect(share.status).toBe(200);
    const [shareRow] = await auditRows({ org_id: orgId, action: 'share_link.saved' });
    expect(shareRow!.actor_id).toBe(owner.id);
    expect(shareRow!.resource_id).toBe(share.body.sharedLink.id);
    expect(shareRow!.request_id).toBe(String(share.headers['x-request-id']));

    const exp = await request(live!.app).post(`/api/v1/projects/${projectId}/export`).set(auth).send({ format: 'csv' });
    expect(exp.status).toBeLessThan(300);
    expect((await auditRows({ org_id: orgId, action: 'export.created' }))[0]!.resource_id).toBe(projectId);

    const board = await request(live!.app)
      .post('/api/v1/boards').set(auth)
      .send({ projectId, title: 'B', slug: `pp22-${randomUUID().slice(0, 8)}` });
    expect(board.status).toBe(201);
    expect((await auditRows({ org_id: orgId, action: 'board.created' }))[0]!.resource_id).toBe(board.body.board.id);

    const portal = await request(live!.app)
      .post('/api/v1/portals').set(auth)
      .send({ projectId, slug: `pp22p-${randomUUID().slice(0, 8)}`, title: 'Portal' });
    expect(portal.status).toBe(201);
    const portalId = portal.body.portal.id as string;
    expect((await auditRows({ org_id: orgId, action: 'portal.created' }))[0]!.resource_id).toBe(portalId);
    const patched = await request(live!.app).patch(`/api/v1/portals/${portalId}`).set(auth).send({ title: 'Portal 2' });
    expect(patched.status).toBe(200);
    expect((await auditRows({ org_id: orgId, action: 'portal.updated' }))).toHaveLength(1);
    const del = await request(live!.app).delete(`/api/v1/portals/${portalId}`).set(auth);
    expect(del.status).toBeLessThan(300);
    expect((await auditRows({ org_id: orgId, action: 'portal.deleted' }))).toHaveLength(1);

    const connect = await request(live!.app).post('/api/v1/integrations/slack/connect').set(auth).send({ accessToken: 'xoxb-secret-token-value' });
    expect(connect.status).toBe(201);
    const disc = await request(live!.app).delete('/api/v1/integrations/slack').set(auth);
    expect(disc.status).toBe(204);
    expect((await auditRows({ org_id: orgId, action: 'integration.connected' }))).toHaveLength(1);
    expect((await auditRows({ org_id: orgId, action: 'integration.disconnected' }))).toHaveLength(1);

    const inv = await request(live!.app).post('/api/v1/org/invitations').set(auth).send({ email: 'invitee@hardening.example.test', role: 'member' });
    expect(inv.status).toBe(201);
    const [invRow] = await auditRows({ org_id: orgId, action: 'invitation.created' });
    expect(invRow!.resource_id).toBe(inv.body.invitationId);
    expect(JSON.stringify(invRow!.metadata)).not.toContain('invitee@');

    // No secret ever lands in the trail.
    const all = JSON.stringify(await live!.db('audit_logs').where({ org_id: orgId }));
    expect(all).not.toContain('xoxb-secret-token-value');
  });

  it('does not record failed mutations (4xx) or double-record routes that audit themselves', async (ctx) => {
    if (skip) return ctx.skip();
    const { orgId, actors } = await live!.seedOrg(['owner']);
    const auth = { Authorization: `Bearer ${await actors.owner!.token()}` };
    const bad = await request(live!.app).post(`/api/v1/projects/${randomUUID()}/share`).set(auth).send({});
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const key = await request(live!.app).post('/api/v1/api-keys').set(auth).send({ name: 'k' });
    expect(key.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 300));
    expect(await live!.db('audit_logs').where({ org_id: orgId, action: 'share_link.saved' })).toHaveLength(0);
    expect(await live!.db('audit_logs').where({ org_id: orgId, action: 'api_key.created' })).toHaveLength(1);
  });

  it('audit rows cannot be updated, deleted or truncated by the application role; org erasure still cascades', async (ctx) => {
    if (skip) return ctx.skip();
    const orgId = randomUUID();
    await live!.db('organizations').insert({ id: orgId, name: 'pp22-erase', slug: `pp22e-${orgId.slice(0, 10)}` });
    await live!.db('audit_logs').insert({ org_id: orgId, action: 'x.y', resource_type: 'x' });
    await expect(live!.db('audit_logs').where({ org_id: orgId }).update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(live!.db('audit_logs').where({ org_id: orgId }).del()).rejects.toThrow(/append-only/);
    await expect(live!.db.raw('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
    expect(await live!.db('audit_logs').where({ org_id: orgId, action: 'x.y' })).toHaveLength(1);
    await live!.db('organizations').where({ id: orgId }).del();
    expect(await live!.db('audit_logs').where({ org_id: orgId })).toHaveLength(0);
  });

  it('audit-log route: new filters (actionPrefix, resourceType, resourceId, ip, requestId) and context fields; admin only', async (ctx) => {
    if (skip) return ctx.skip();
    const { orgId, actors } = await live!.seedOrg(['owner', 'viewer']);
    const projectId = await live!.seedProject(orgId, actors.owner!.id);
    const auth = { Authorization: `Bearer ${await actors.owner!.token()}` };
    const share = await request(live!.app).post(`/api/v1/projects/${projectId}/share`).set(auth).send({});
    const rid = String(share.headers['x-request-id']);
    await auditRows({ org_id: orgId, action: 'share_link.saved' });
    await live!.db('audit_logs').insert({ org_id: orgId, action: 'other.thing', resource_type: 'other' });

    const q = async (qs: string) => request(live!.app).get(`/api/v1/org/audit-log?${qs}`).set(auth);
    const byPrefix = await q('actionPrefix=share_link.');
    expect(byPrefix.status).toBe(200);
    expect(byPrefix.body.data.map((r: any) => r.action)).toEqual(['share_link.saved']);
    expect(byPrefix.body.data[0].requestId).toBe(rid);
    expect(byPrefix.body.data[0].ipAddress).toBeTruthy();
    expect(byPrefix.body.data[0]).toHaveProperty('userAgent');
    expect((await q(`requestId=${rid}`)).body.data).toHaveLength(1);
    expect((await q('requestId=nope')).body.data).toHaveLength(0);
    expect((await q('resourceType=other')).body.data.map((r: any) => r.action)).toEqual(['other.thing']);
    expect((await q(`resourceId=${share.body.sharedLink.id}`)).body.data).toHaveLength(1);
    expect((await q(`ip=${encodeURIComponent(byPrefix.body.data[0].ipAddress)}`)).body.data.length).toBeGreaterThanOrEqual(1);
    // `_` / `%` in the prefix are matched literally (no LIKE wildcard injection)
    expect((await q('actionPrefix=share%25')).status).toBe(400);
    expect((await q('actionPrefix=share_link_')).body.data).toHaveLength(0);

    const viewer = await request(live!.app).get('/api/v1/org/audit-log').set({ Authorization: `Bearer ${await actors.viewer!.token()}` });
    expect(viewer.status).toBe(403);
  });
});

describe('PP-21 tokens at rest', () => {
  it('PgIntegrationRepo stores access/refresh tokens as SecretBox ciphertext and round-trips them', async (ctx) => {
    if (skip) return ctx.skip();
    const { orgId } = await live!.seedOrg([]);
    const box = new SecretBox(deriveKey(Buffer.alloc(32, 7).toString('base64')));
    const repo = new PgIntegrationRepo(live!.db, box);
    await repo.upsert(orgId, 'slack', { accessToken: 'at-plain-123', refreshToken: 'rt-plain-456', config: { workspace: 'Acme' } });
    const raw = await live!.db('integrations').where({ org_id: orgId, provider: 'slack' }).first();
    expect(raw.access_token).toMatch(/^v1\./);
    expect(raw.refresh_token).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain('at-plain-123');
    expect(JSON.stringify(raw)).not.toContain('rt-plain-456');
    const back = await repo.findByOrgAndProvider(orgId, 'slack');
    expect(back!.accessToken).toBe('at-plain-123');
    expect(back!.refreshToken).toBe('rt-plain-456');
  });

  it('the live composition root encrypts a token pasted through POST /integrations/:provider/connect', async (ctx) => {
    if (skip) return ctx.skip();
    const { orgId, actors } = await live!.seedOrg(['owner']);
    const res = await request(live!.app)
      .post('/api/v1/integrations/linear/connect')
      .set({ Authorization: `Bearer ${await actors.owner!.token()}` })
      .send({ accessToken: 'lin-plain-token' });
    expect(res.status).toBe(201);
    const raw = await live!.db('integrations').where({ org_id: orgId, provider: 'linear' }).first();
    expect(raw.access_token).toMatch(/^v1\./);
    expect(raw.access_token).not.toContain('lin-plain-token');
  });

  it('an unconfigured provider cannot start OAuth (501, no placeholder redirect)', async (ctx) => {
    if (skip) return ctx.skip();
    const { actors } = await live!.seedOrg(['owner']);
    const res = await request(live!.app)
      .post('/api/v1/integrations/github/connect')
      .set({ Authorization: `Bearer ${await actors.owner!.token()}` })
      .send({});
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });
});

describe('PP-20 public board abuse controls (real DB)', () => {
  async function boardApp(quotas: Record<string, number> = {}) {
    const { orgId, actors } = await live!.seedOrg(['owner']);
    const projectId = await live!.seedProject(orgId, actors.owner!.id);
    const slug = `pp20-${randomUUID().slice(0, 8)}`;
    const [board] = await live!.db('feedback_boards').insert({ org_id: orgId, project_id: projectId, slug, title: 'T' }).returning('*');
    const app = express();
    app.set('trust proxy', true); // lets the test present distinct client IPs
    app.use(express.json());
    app.use('/api/v1', createPremiumRoutes({
      authMiddleware: (_req, _res, next) => next(),
      db: live!.db,
      voterHashSecret: 'test-secret',
      quotas: { windowMs: 60_000, ...quotas },
    }));
    const post = async (ip: string, title = 'A thing') => {
      const res = await request(app).post(`/api/v1/board/${slug}/posts`).set('X-Forwarded-For', ip)
        .send({ title, body: 'details', email: `p-${randomUUID().slice(0, 6)}@x.test` });
      return res;
    };
    const vote = (ip: string, postId: string, email: string) =>
      request(app).post(`/api/v1/board/${slug}/posts/${postId}/vote`).set('X-Forwarded-For', ip).send({ email });
    return { app, slug, board, post, vote };
  }

  beforeEach(() => __resetWidgetRateLimitMemory());

  it('one network identity gets one vote per post even when it types a new e-mail each time', async (ctx) => {
    if (skip) return ctx.skip();
    const { post, vote, board } = await boardApp();
    const p = (await post('10.0.0.1')).body.post;
    expect((await vote('10.0.0.2', p.id, 'a@x.test')).status).toBe(201);
    const stuffed = await vote('10.0.0.2', p.id, 'fresh-address@x.test');
    expect(stuffed.status).toBe(409);
    // same e-mail from another network is still a duplicate (legacy PK)
    expect((await vote('10.0.0.3', p.id, 'a@x.test')).status).toBe(409);
    // a different network + different e-mail is a legitimate second voter
    expect((await vote('10.0.0.4', p.id, 'b@x.test')).status).toBe(201);
    const row = await live!.db('board_posts').where({ id: p.id }).first('vote_count');
    expect(row.vote_count).toBe(2);
    const keys = await live!.db('board_votes').where({ post_id: p.id }).select('voter_key');
    expect(keys.every((k: any) => /^ip:[0-9a-f]{32}$/.test(k.voter_key))).toBe(true);
    expect(JSON.stringify(keys)).not.toContain('10.0.0.');
    expect(board.id).toBeTruthy();
  });

  it('per-IP submit quota: the Nth+1 post from one address is 429 with Retry-After; other addresses are unaffected', async (ctx) => {
    if (skip) return ctx.skip();
    const { post } = await boardApp({ submitPerIpWindow: 2, submitPerIpDay: 100, submitPerBoardWindow: 100, submitPerBoardDay: 1000 });
    expect((await post('10.1.0.1')).status).toBe(201);
    expect((await post('10.1.0.1')).status).toBe(201);
    const limited = await post('10.1.0.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await post('10.1.0.2')).status).toBe(201);
  });

  it('per-board submit quota applies across different addresses', async (ctx) => {
    if (skip) return ctx.skip();
    const { post } = await boardApp({ submitPerBoardWindow: 2, submitPerBoardDay: 1000, submitPerIpWindow: 100, submitPerIpDay: 1000 });
    expect((await post('10.2.0.1')).status).toBe(201);
    expect((await post('10.2.0.2')).status).toBe(201);
    expect((await post('10.2.0.3')).status).toBe(429);
  });

  it('daily quotas bind independently of the burst window', async (ctx) => {
    if (skip) return ctx.skip();
    const { post } = await boardApp({ submitPerIpWindow: 100, submitPerIpDay: 1, submitPerBoardWindow: 100, submitPerBoardDay: 1000 });
    expect((await post('10.3.0.1')).status).toBe(201);
    expect((await post('10.3.0.1')).status).toBe(429);
  });

  it('vote quotas: per-IP burst limit rejects with 429 before touching the database', async (ctx) => {
    if (skip) return ctx.skip();
    const { post, vote } = await boardApp({ votePerIpWindow: 2, votePerIpDay: 100, votePerBoardWindow: 100, votePerBoardDay: 1000, submitPerIpWindow: 100, submitPerIpDay: 1000 });
    const posts = [];
    for (let i = 0; i < 3; i++) posts.push((await post(`10.4.1.${i}`)).body.post);
    expect((await vote('10.4.0.9', posts[0].id, 'q1@x.test')).status).toBe(201);
    expect((await vote('10.4.0.9', posts[1].id, 'q2@x.test')).status).toBe(201);
    const third = await vote('10.4.0.9', posts[2].id, 'q3@x.test');
    expect(third.status).toBe(429);
    const count = await live!.db('board_posts').where({ id: posts[2].id }).first('vote_count');
    expect(count.vote_count).toBe(0);
  });
});
