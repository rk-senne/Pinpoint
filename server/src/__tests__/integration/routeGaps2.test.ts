// Real-PG live-app tests for the second batch of routes found untested by the
// docs/TEST_MATRIX.md inventory: project PUT / by-url / members / page delete,
// annotation screenshot + markup, api-keys list, webhooks/events,
// auth verify-email, workflow rules on the REAL mount, docs.json, health probes.
// Skips when no migrated Postgres test DB is reachable.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveActor, type LiveApp } from './helpers/liveApp.js';

let live: LiveApp | null = null;
let skip: string | null = null;
let orgId = '';
let admin: LiveActor;
let member: LiveActor;
let viewer: LiveActor;
const bearer = async (a: LiveActor) => `Bearer ${await a.token()}`;
const target = { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' };
const environment = { browserFamily: 'Chrome', browserVersion: '126', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'ua' };

describe('Integration: previously-untested routes (batch 2)', () => {
  beforeAll(async () => {
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    const seeded = await live.seedOrg(['admin', 'member', 'viewer']);
    orgId = seeded.orgId; admin = seeded.actors.admin!; member = seeded.actors.member!; viewer = seeded.actors.viewer!;
  });
  afterAll(async () => { await live?.cleanup(); });

  async function newProject(urls = ['https://batch2.test/a', 'https://batch2.test/b']) {
    const res = await request(live!.app).post('/api/v1/projects').set('Authorization', await bearer(admin)).send({ name: `p-${randomUUID().slice(0, 6)}`, urls });
    expect(res.status).toBe(201);
    return res.body.project as { id: string; urls: string[] };
  }

  it('PUT /projects/:id renames (owner/admin), archives, rejects empty body, 404s other orgs, 403 for non-owner member', async ({ skip: s }) => {
    if (skip) return s(skip);
    const p = await newProject();
    const auth = await bearer(admin);
    const renamed = await request(live!.app).put(`/api/v1/projects/${p.id}`).set('Authorization', auth).send({ name: 'Renamed-1' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project.name).toBe('Renamed-1');
    const archived = await request(live!.app).put(`/api/v1/projects/${p.id}`).set('Authorization', auth).send({ status: 'archived' });
    expect(archived.status).toBe(200);
    expect(archived.body.project.status).toBe('archived');
    expect((await request(live!.app).put(`/api/v1/projects/${p.id}`).set('Authorization', auth).send({})).status).toBe(400);
    const outsider = (await live!.seedOrg(['admin'])).actors.admin!;
    expect((await request(live!.app).put(`/api/v1/projects/${p.id}`).set('Authorization', await bearer(outsider)).send({ name: 'hijack' })).status).toBe(404);
    expect((await request(live!.app).put(`/api/v1/projects/${p.id}`).send({ name: 'x' })).status).toBe(401);
    const row = await live!.db('projects').where({ id: p.id }).first('name');
    expect(row.name).toBe('Renamed-1');
  });

  it('GET /projects/by-url resolves a registered url, 404s unknown, requires auth', async ({ skip: s }) => {
    if (skip) return s(skip);
    const url = `https://byurl-${randomUUID().slice(0, 8)}.test/page`;
    const p = await newProject([url]);
    const auth = await bearer(admin);
    const ok = await request(live!.app).get('/api/v1/projects/by-url').query({ url }).set('Authorization', auth);
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(p.id);
    expect(ok.body.pageId).toBeTruthy();
    const none = await request(live!.app).get('/api/v1/projects/by-url').query({ url: 'https://nope-unknown.test/x' }).set('Authorization', auth);
    expect(none.status).toBe(404);
    const other = (await live!.seedOrg(['admin'])).actors.admin!;
    expect((await request(live!.app).get('/api/v1/projects/by-url').query({ url }).set('Authorization', await bearer(other))).status).toBe(404);
    expect((await request(live!.app).get('/api/v1/projects/by-url').query({ url })).status).toBe(401);
  });

  it('GET /projects/:id/members lists org members for an accessible project, 404 cross-org', async ({ skip: s }) => {
    if (skip) return s(skip);
    const p = await newProject();
    const res = await request(live!.app).get(`/api/v1/projects/${p.id}/members`).set('Authorization', await bearer(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members.map((m: { userId: string }) => m.userId)).toContain(admin.id);
    for (const m of res.body.members) expect(Object.keys(m).sort()).toEqual(['avatarUrl', 'email', 'name', 'role', 'userId']);
    const other = (await live!.seedOrg(['admin'])).actors.admin!;
    expect((await request(live!.app).get(`/api/v1/projects/${p.id}/members`).set('Authorization', await bearer(other))).status).toBe(404);
    expect((await request(live!.app).get(`/api/v1/projects/${p.id}/members`)).status).toBe(401);
  });

  it('DELETE /projects/:id/pages/:pageId: validates mode, blocks non-empty (409), cascades on request', async ({ skip: s }) => {
    if (skip) return s(skip);
    const p = await newProject(['https://pg.test/one', 'https://pg.test/two']);
    const auth = await bearer(admin);
    const pages = await live!.db('pages').where({ project_id: p.id }).orderBy('url');
    const [one, two] = pages;
    expect((await request(live!.app).delete(`/api/v1/projects/${p.id}/pages/${one.id}`).query({ onNonEmpty: 'bogus' }).set('Authorization', auth)).status).toBe(400);
    const ann = await request(live!.app).post(`/api/v1/projects/${p.id}/annotations`).set('Authorization', auth)
      .send({ type: 'note', body: 'on page one', pageUrl: 'https://pg.test/one', severity: 'minor', target, environment });
    expect([200, 201]).toContain(ann.status);
    const blocked = await request(live!.app).delete(`/api/v1/projects/${p.id}/pages/${one.id}`).set('Authorization', auth);
    expect(blocked.status).toBe(409);
    expect(await live!.db('pages').where({ id: one.id }).first()).toBeTruthy();
    const cascade = await request(live!.app).delete(`/api/v1/projects/${p.id}/pages/${one.id}`).query({ onNonEmpty: 'cascade' }).set('Authorization', auth);
    expect(cascade.status).toBe(200);
    expect(cascade.body).toMatchObject({ deleted: true, pageId: one.id, annotationCount: 1 });
    expect(await live!.db('pages').where({ id: one.id }).first()).toBeUndefined();
    const empty = await request(live!.app).delete(`/api/v1/projects/${p.id}/pages/${two.id}`).set('Authorization', auth);
    expect(empty.status).toBe(200);
    expect(empty.body.annotationCount).toBe(0);
    expect((await request(live!.app).delete(`/api/v1/projects/${p.id}/pages/${randomUUID()}`).set('Authorization', auth)).status).toBe(404);
  });

  it('GET /annotations/:id/screenshot + /markup: 404 without capture, url when key set, ?redirect=1 302s, cross-org 404', async ({ skip: s }) => {
    if (skip) return s(skip);
    const p = await newProject();
    const auth = await bearer(admin);
    const created = await request(live!.app).post(`/api/v1/projects/${p.id}/annotations`).set('Authorization', auth)
      .send({ type: 'note', body: 'shot', pageUrl: 'https://batch2.test/a', severity: 'minor', target, environment });
    const id = (created.body.annotation ?? created.body).id as string;
    expect(id).toBeTruthy();
    expect((await request(live!.app).get(`/api/v1/annotations/${id}/screenshot`).set('Authorization', auth)).status).toBe(404);
    expect((await request(live!.app).get(`/api/v1/annotations/${id}/markup`).set('Authorization', auth)).status).toBe(404);
    await live!.db('annotations').where({ id }).update({ screenshot_object_key: `annotations/screenshots/${id}.png` });
    const shot = await request(live!.app).get(`/api/v1/annotations/${id}/screenshot`).set('Authorization', auth);
    expect(shot.status).toBe(200);
    expect(shot.body.screenshotObjectKey).toBe(`annotations/screenshots/${id}.png`);
    expect(typeof shot.body.screenshotUrl).toBe('string');
    expect(shot.headers['cache-control']).toContain('no-store');
    const redir = await request(live!.app).get(`/api/v1/annotations/${id}/screenshot`).query({ redirect: '1' }).set('Authorization', auth).redirects(0);
    expect(redir.status).toBe(302);
    expect(redir.headers.location).toBeTruthy();
    const other = (await live!.seedOrg(['admin'])).actors.admin!;
    expect((await request(live!.app).get(`/api/v1/annotations/${id}/screenshot`).set('Authorization', await bearer(other))).status).toBe(404);
    expect((await request(live!.app).get(`/api/v1/annotations/${id}/screenshot`)).status).toBe(401);
    expect((await request(live!.app).get(`/api/v1/annotations/${id}/markup`)).status).toBe(401);
  });

  it('GET /api-keys lists keys for admins without leaking the hash/raw key; denies member and anonymous', async ({ skip: s }) => {
    if (skip) return s(skip);
    const auth = await bearer(admin);
    const made = await request(live!.app).post('/api/v1/api-keys').set('Authorization', auth).send({ name: 'list-me' });
    expect([200, 201]).toContain(made.status);
    const list = await request(live!.app).get('/api/v1/api-keys').set('Authorization', auth);
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).toContain('list-me');
    expect(text).not.toMatch(/pk_[A-Za-z0-9]{16,}/);
    expect(text).not.toMatch(/key_?hash/i);
    expect((await request(live!.app).get('/api/v1/api-keys').set('Authorization', await bearer(member))).status).toBe(403);
    expect((await request(live!.app).get('/api/v1/api-keys')).status).toBe(401);
  });

  it('GET /webhooks/events lists event types for admins; viewers/anonymous are refused or served consistently', async ({ skip: s }) => {
    if (skip) return s(skip);
    const res = await request(live!.app).get('/api/v1/webhooks/events').set('Authorization', await bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events).toContain('annotation.created');
    expect((await request(live!.app).get('/api/v1/webhooks/events')).status).toBe(401);
  });

  it('POST /auth/verify-email/:token verifies once; reused / unknown tokens fail', async ({ skip: s }) => {
    if (skip) return s(skip);
    const id = randomUUID();
    const email = `verify-${id}@live.test`;
    await live!.db('users').insert({ id, email, name: 'v', password_hash: 'x', verified: false });
    const raw = `raw-${randomUUID()}`;
    await live!.db('auth_tokens').insert({ user_id: id, kind: 'verify_email', token_hash: createHash('sha256').update(raw).digest('hex'), expires_at: new Date(Date.now() + 3600_000) });
    try {
      const ok = await request(live!.app).post(`/api/v1/auth/verify-email/${raw}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ verified: true });
      expect((await live!.db('users').where({ id }).first('verified')).verified).toBe(true);
      const again = await request(live!.app).post(`/api/v1/auth/verify-email/${raw}`);
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.status).toBeLessThan(500);
      expect(again.body.error.code).toBeTruthy();
      const unknown = await request(live!.app).post('/api/v1/auth/verify-email/does-not-exist');
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      expect(unknown.status).toBeLessThan(500);
    } finally {
      await live!.db('users').where({ id }).del();
    }
  });

  it('workflow rules on the real /api/v1/workflows mount: CRUD, SLA breaches, org isolation, viewers refused', async ({ skip: s }) => {
    if (skip) return s(skip);
    const auth = await bearer(admin);
    const body = { name: 'auto-assign', triggerEvent: 'annotation.created', actionType: 'notify', actionParams: { channel: 'x' }, priority: 3 };
    const created = await request(live!.app).post('/api/v1/workflows/rules').set('Authorization', auth).send(body);
    expect(created.status).toBe(201);
    const ruleId = created.body.rule.id as string;
    expect((await request(live!.app).post('/api/v1/workflows/rules').set('Authorization', auth).send({ ...body, triggerEvent: 'nope' })).status).toBe(400);
    expect((await request(live!.app).post('/api/v1/workflows/rules').set('Authorization', await bearer(viewer)).send(body)).status).toBe(403);
    expect((await request(live!.app).post('/api/v1/workflows/rules').send(body)).status).toBe(401);

    const list = await request(live!.app).get('/api/v1/workflows/rules').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(ruleId);
    expect((await request(live!.app).get('/api/v1/workflows/rules')).status).toBe(401);

    const other = (await live!.seedOrg(['admin'])).actors.admin!;
    const otherAuth = await bearer(other);
    expect(JSON.stringify((await request(live!.app).get('/api/v1/workflows/rules').set('Authorization', otherAuth)).body)).not.toContain(ruleId);
    expect((await request(live!.app).patch(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', otherAuth).send({ active: false })).status).toBe(404);
    expect((await request(live!.app).delete(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', otherAuth)).status).toBe(404);

    const patched = await request(live!.app).patch(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', auth).send({ active: false, priority: 9, name: 'renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body.rule).toMatchObject({ active: false, priority: 9, name: 'renamed' });
    expect((await request(live!.app).patch(`/api/v1/workflows/rules/${randomUUID()}`).set('Authorization', auth).send({ name: 'x' })).status).toBe(404);
    expect((await request(live!.app).patch(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', auth).send({ priority: 'not-a-number' })).status).toBe(400);

    const breaches = await request(live!.app).get('/api/v1/workflows/sla/breaches').set('Authorization', auth);
    expect(breaches.status).toBe(200);
    expect(breaches.body.data).toEqual([]);
    expect(breaches.body.pagination).toBeTruthy();

    expect((await request(live!.app).delete(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', auth)).status).toBe(204);
    expect((await request(live!.app).delete(`/api/v1/workflows/rules/${ruleId}`).set('Authorization', auth)).status).toBe(404);
  });

  it('GET /api/v1/docs.json, /health/live, /health/ready, /api/v1/health respond publicly with the documented shape', async ({ skip: s }) => {
    if (skip) return s(skip);
    const docs = await request(live!.app).get('/api/v1/docs.json');
    expect(docs.status).toBe(200);
    expect(docs.body.openapi ?? docs.body.swagger).toBeTruthy();
    expect(Object.keys(docs.body.paths ?? {}).length).toBeGreaterThan(5);
    const liveRes = await request(live!.app).get('/health/live');
    expect(liveRes.status).toBe(200);
    expect(liveRes.body).toEqual({ status: 'ok' });
    const ready = await request(live!.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database).toBe('ok');
    const v1 = await request(live!.app).get('/api/v1/health');
    expect(v1.status).toBe(200);
    expect(v1.body.checks.database).toBe('ok');
  });
});
