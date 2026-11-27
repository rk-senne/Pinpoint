// Real-PG regression tests for the Low findings of docs/SECURITY_REVIEW.md
// (PP-09, PP-11, PP-12, PP-13, PP-14, PP-24, PP-25). Boots the real composition root.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveActor, type LiveApp } from './helpers/liveApp.js';
import { PgWebhookRepo } from '../../adapters/outbound/postgres/PgWebhookRepo.js';
import { SecretBox } from '../../services/secretBox.js';
import { PgUserRepo } from '../../adapters/outbound/postgres/PgUserRepo.js';
import { createIpAttemptLimiter } from '../../adapters/inbound/http/sharedLinks.routes.js';

let live: LiveApp | null = null;
let skip: string | null = null;
let admin: LiveActor;
let member: LiveActor;
let outsider: LiveActor; // other org
let projectId = '';
let annotationId = '';

const auth = async (a: LiveActor) => `Bearer ${await a.token()}`;
const get = async (a: LiveActor, p: string) => request(live!.app).get(p).set('Authorization', await auth(a));
const send = async (m: 'post' | 'put' | 'patch', a: LiveActor, p: string, body: unknown) =>
  request(live!.app)[m](p).set('Authorization', await auth(a)).send(body as object);

describe('Integration: security review — Low findings', () => {
  beforeAll(async () => {
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    const { orgId, actors } = await live.seedOrg(['admin', 'member']);
    admin = actors.admin!; member = actors.member!;
    outsider = (await live.seedOrg(['owner'])).actors.owner!;
    projectId = await live.seedProject(orgId, admin.id);
    const pageId = randomUUID();
    await live.db('pages').insert({ id: pageId, project_id: projectId, url: 'https://example.com/' });
    annotationId = randomUUID();
    await live.db('annotations').insert({
      id: annotationId, project_id: projectId, page_id: pageId, org_id: orgId, author_id: admin.id,
      type: 'note', severity: 'minor', body: 'hello', pin_number: 1, status: 'active',
      target: JSON.stringify({ cssSelector: 'body', xpath: '/html/body', pageX: 1, pageY: 1, tagName: 'body', textSnippet: '' }),
    });
  });
  afterAll(async () => {
    await live?.db('annotations').where({ project_id: projectId }).del().catch(() => undefined);
    await live?.db('shared_links').where({ project_id: projectId }).del().catch(() => undefined);
    await live?.cleanup();
  });

  describe('PP-09 assignee / mentions', () => {
    it('rejects a non-UUID assignee with 400 (was 500) and a non-member assignee with 400', async ({ skip: s }) => {
      if (skip) return s(skip);
      expect((await send('put', admin, `/api/v1/annotations/${annotationId}`, { assigneeId: 'not-a-uuid' })).status).toBe(400);
      expect((await send('put', admin, `/api/v1/annotations/${annotationId}`, { assigneeId: outsider.id })).status).toBe(400);
      expect((await send('put', admin, `/api/v1/annotations/${annotationId}`, { assigneeId: member.id })).status).toBe(200);
    });

    it('drops mentions of users outside the org: no notification, not stored', async ({ skip: s }) => {
      if (skip) return s(skip);
      const res = await send('post', admin, `/api/v1/annotations/${annotationId}/comments`, {
        body: `hi @${outsider.id} and @${member.id}`,
        mentions: [outsider.id, member.id],
      });
      expect(res.status).toBe(201);
      expect(res.body.comment.mentions).toEqual([member.id]);
      const bad = await send('post', admin, `/api/v1/annotations/${annotationId}/comments`, { body: 'x', mentions: ['nope'] });
      expect(bad.status).toBe(400);
    });
  });

  describe('PP-13 bounded input → 400, never 500', () => {
    it('long / malformed strings', async ({ skip: s }) => {
      if (skip) return s(skip);
      expect((await send('put', admin, '/api/v1/users/me', { name: 'x'.repeat(5000) })).status).toBe(400);
      expect((await send('post', admin, '/api/v1/projects', { name: 'x'.repeat(5000), urls: ['https://example.com/'] })).status).toBe(400);
      expect((await send('post', admin, '/api/v1/webhooks', { url: `https://example.com/${'a'.repeat(3000)}`, events: ['annotation.created'] })).status).toBe(400);
      expect((await get(admin, '/api/v1/org/audit-log?dateFrom=garbage')).status).toBe(400);
      expect((await get(admin, '/api/v1/org/audit-log?dateFrom=2026-01-01')).status).toBe(200);
    });
  });

  describe('PP-12 registration validation', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['malformed e-mail', { email: 'notanemail', password: 'Correct-Horse-Battery-9', name: 'A' }],
      ['blocklist word + digits', { email: 'a@b.test', password: 'Password1234', name: 'A' }],
      ['one repeated character', { email: 'a@b.test', password: 'aaaaaaaaaaaa', name: 'A' }],
      ['5000-char name', { email: 'a@b.test', password: 'Correct-Horse-Battery-9', name: 'x'.repeat(5000) }],
    ];
    for (const [label, body] of cases) {
      it(`rejects: ${label}`, async ({ skip: s }) => {
        if (skip) return s(skip);
        const res = await request(live!.app).post('/api/v1/auth/register').send(body);
        expect(res.status).toBe(400);
      });
    }
  });

  describe('PP-14 guest feedback on password-protected links', () => {
    it('requires the access grant; the grant from /verify unlocks it', async ({ skip: s }) => {
      if (skip) return s(skip);
      const share = await send('post', admin, `/api/v1/projects/${projectId}/share`, { password: 'Link-Pass-12345', allowFeedback: true });
      expect(share.status).toBeLessThan(300);
      const linkId = share.body.sharedLink.id;
      expect(linkId).toBeTruthy();
      const payload = { name: 'Guest', description: 'looks off', pageUrl: 'https://example.com/' };

      const noGrant = await request(live!.app).post(`/api/v1/shared/${linkId}/feedback`).send(payload);
      expect(noGrant.status).toBe(401);
      expect(noGrant.body.error.code).toBe('SHARED_ACCESS_REQUIRED');

      const verify = await request(live!.app).post(`/api/v1/shared/${linkId}/verify`).send({ password: 'Link-Pass-12345' });
      expect(verify.status).toBe(200);
      const cookie = ([] as string[]).concat(verify.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
      const withGrant = await request(live!.app).post(`/api/v1/shared/${linkId}/feedback`).set('Cookie', cookie).send(payload);
      expect(withGrant.status).toBe(201);

      // a grant for this link is useless on another link
      const other = await send('post', admin, `/api/v1/projects/${await live!.seedProject(admin.orgId, admin.id)}/share`, { password: 'Other-Pass-12345', allowFeedback: true });
      const otherId = other.body.sharedLink.id;
      expect((await request(live!.app).post(`/api/v1/shared/${otherId}/feedback`).set('Cookie', cookie).send(payload)).status).toBe(401);
    });

    it('per-(link, IP) limiter: 3 failures lock only that key, success resets', () => {
      let now = 1_000;
      const lim = createIpAttemptLimiter({ max: 3, lockMs: 900_000, now: () => now });
      expect(lim.fail('L|1.1.1.1')).toBe(2);
      expect(lim.fail('L|1.1.1.1')).toBe(1);
      expect(lim.fail('L|1.1.1.1')).toBe(0);
      expect(lim.retryAfter('L|1.1.1.1')).toBe(900);
      expect(lim.retryAfter('L|2.2.2.2')).toBe(0); // another visitor is unaffected
      expect(lim.retryAfter('M|1.1.1.1')).toBe(0); // another link too
      now += 900_001;
      expect(lim.retryAfter('L|1.1.1.1')).toBe(0);
      lim.fail('L|3.3.3.3'); lim.reset('L|3.3.3.3');
      expect(lim.fail('L|3.3.3.3')).toBe(2);
    });
  });

  describe('PP-24 / PP-25 project + screenshot access', () => {
    it('a foreign project is a 404, indistinguishable from a random id', async ({ skip: s }) => {
      if (skip) return s(skip);
      const foreign = await get(outsider, `/api/v1/projects/${projectId}`);
      const random = await get(outsider, `/api/v1/projects/${randomUUID()}`);
      expect(foreign.status).toBe(404);
      expect(random.status).toBe(404);
      expect(foreign.body.error.code).toBe(random.body.error.code);
    });

    it('GET /annotations/:id/screenshot|markup: mounted, access-checked, 404 without a capture', async ({ skip: s }) => {
      if (skip) return s(skip);
      expect((await get(admin, `/api/v1/annotations/${annotationId}/screenshot`)).status).toBe(404); // no capture yet
      expect((await get(admin, `/api/v1/annotations/${annotationId}/markup`)).status).toBe(404);
      expect((await get(outsider, `/api/v1/annotations/${annotationId}/screenshot`)).status).toBe(404); // foreign org
      await live!.db('annotations').where({ id: annotationId }).update({ screenshot_object_key: `annotations/screenshots/${annotationId}.png` });
      const ok = await get(admin, `/api/v1/annotations/${annotationId}/screenshot`);
      expect(ok.status).toBe(200);
      expect(ok.body.screenshotObjectKey).toContain(annotationId);
      // S3 driver: presigned/public URL embeds the key; local driver (default without S3 env):
      // an opaque HMAC-signed /api/v1/screenshots/<token> URL that does not reveal the key.
      expect(ok.body.screenshotUrl.includes(annotationId) || /\/api\/v1\/screenshots\/[^/]+$/.test(ok.body.screenshotUrl)).toBe(true);
      expect((await get(outsider, `/api/v1/annotations/${annotationId}/screenshot`)).status).toBe(404);
      // ?redirect=1 (export links): 302 to the same URL for members, still 404 for outsiders.
      const redir = await get(admin, `/api/v1/annotations/${annotationId}/screenshot?redirect=1`);
      expect(redir.status).toBe(302);
      expect(redir.headers.location).toBe(ok.body.screenshotUrl);
      expect((await get(outsider, `/api/v1/annotations/${annotationId}/screenshot?redirect=1`)).status).toBe(404);
    });
  });

  describe('PP-11 webhook signing secrets at rest', () => {
    it('are stored as an AES-GCM envelope and read back transparently (legacy plaintext still works)', async ({ skip: s }) => {
      if (skip) return s(skip);
      const key = Buffer.alloc(32, 9).toString('base64');
      const repo = new PgWebhookRepo(live!.db, SecretBox.fromRawKey(key));
      const created = await repo.insert({ orgId: admin.orgId, url: 'https://example.com/hook', secret: 'whsec_c2VjcmV0LXZhbHVl', events: ['annotation.created'] });
      expect(created.secret).toBe('whsec_c2VjcmV0LXZhbHVl');
      const raw = await live!.db('webhook_endpoints').where({ id: created.id }).first('secret');
      expect(raw.secret).toMatch(/^v1\./);
      expect(raw.secret).not.toContain('whsec_');
      expect((await repo.findEndpointById(created.id))!.secret).toBe('whsec_c2VjcmV0LXZhbHVl');
      // a pre-migration plaintext row is still readable
      await live!.db('webhook_endpoints').where({ id: created.id }).update({ secret: 'legacy-plaintext-secret' });
      expect((await repo.findEndpointById(created.id))!.secret).toBe('legacy-plaintext-secret');
    });
  });

  describe('PP-02 session revocation cuts realtime', () => {
    it('every token_version bump (logout, reset, revoke-sessions, removal) fires onSessionRevoked(userId)', async ({ skip: s }) => {
      if (skip) return s(skip);
      const repo = new PgUserRepo(live!.db);
      const seen: string[] = [];
      repo.onSessionRevoked = (id) => seen.push(id);
      await repo.incrementTokenVersion(member.id);
      expect(seen).toEqual([member.id]);
      // a failing hook must never break the revocation itself
      repo.onSessionRevoked = () => { throw new Error('boom'); };
      await expect(repo.incrementTokenVersion(member.id)).resolves.toBeUndefined();
    });
  });
});
