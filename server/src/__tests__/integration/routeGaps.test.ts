// Real-PG live-app tests for routes that previously had NO test at all
// (found by the docs/TEST_MATRIX.md inventory): GET/PATCH /org,
// GET /notifications/preferences, GET /csat/summary, GET /reports/overview,
// GET /portals/:slug/info and POST /integrations/:provider/test.
// Skips when no migrated Postgres test DB is reachable.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveActor, type LiveApp } from './helpers/liveApp.js';

let live: LiveApp | null = null;
let skip: string | null = null;
let orgId = '';
let admin: LiveActor;
let viewer: LiveActor;
let projectId = '';
const bearer = async (a: LiveActor) => `Bearer ${await a.token()}`;

describe('Integration: previously-untested routes', () => {
  beforeAll(async () => {
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    const seeded = await live.seedOrg(['admin', 'viewer']);
    orgId = seeded.orgId; admin = seeded.actors.admin!; viewer = seeded.actors.viewer!;
    projectId = await live.seedProject(orgId, admin.id);
  });
  afterAll(async () => { await live?.cleanup(); });

  it('GET /org returns the caller org; requires auth', async ({ skip: s }) => {
    if (skip) return s(skip);
    expect((await request(live!.app).get('/api/v1/org')).status).toBe(401);
    const res = await request(live!.app).get('/api/v1/org').set('Authorization', await bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body.org).toMatchObject({ id: orgId });
  });

  it('PATCH /org updates name for admins, rejects viewers and invalid bodies, writes an audit row', async ({ skip: s }) => {
    if (skip) return s(skip);
    const name = `Renamed ${randomUUID().slice(0, 6)}`;
    const ok = await request(live!.app).patch('/api/v1/org').set('Authorization', await bearer(admin)).send({ name });
    expect(ok.status).toBe(200);
    expect(ok.body.org.name).toBe(name);
    const denied = await request(live!.app).patch('/api/v1/org').set('Authorization', await bearer(viewer)).send({ name: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const bad = await request(live!.app).patch('/api/v1/org').set('Authorization', await bearer(admin)).send({ slug: 'Not A Slug!!' });
    expect(bad.status).toBe(400);
    const audit = await live!.db('audit_logs').where({ org_id: orgId, action: 'org.settings_updated' }).count('* as c').first();
    expect(Number(audit?.c)).toBeGreaterThanOrEqual(1);
  });

  it('GET /notifications/preferences returns defaults, then reflects PUT', async ({ skip: s }) => {
    if (skip) return s(skip);
    const before = await request(live!.app).get('/api/v1/notifications/preferences').set('Authorization', await bearer(viewer));
    expect(before.status).toBe(200);
    expect(before.body.preferences).toMatchObject({ mention: true });
    const put = await request(live!.app).put('/api/v1/notifications/preferences').set('Authorization', await bearer(viewer))
      .send({ mention: false, commentOnOwn: true, statusChange: false, projectActivity: true });
    expect(put.status).toBeLessThan(300);
    const after = await request(live!.app).get('/api/v1/notifications/preferences').set('Authorization', await bearer(viewer));
    expect(after.body.preferences).toMatchObject({ mention: false, statusChange: false, projectActivity: true });
  });

  it('GET /csat/summary returns an empty summary for an org with no ratings and requires auth', async ({ skip: s }) => {
    if (skip) return s(skip);
    expect((await request(live!.app).get('/api/v1/csat/summary')).status).toBe(401);
    const res = await request(live!.app).get('/api/v1/csat/summary').set('Authorization', await bearer(admin));
    expect(res.status).toBe(200);
    expect(Number(res.body.total_ratings)).toBe(0);
    expect(res.body.avg_score).toBeNull();
  });

  it('GET /reports/overview aggregates only this org and requires auth', async ({ skip: s }) => {
    if (skip) return s(skip);
    expect((await request(live!.app).get('/api/v1/reports/overview')).status).toBe(401);
    const created = await request(live!.app).post(`/api/v1/projects/${projectId}/annotations`).set('Authorization', await bearer(admin))
      .send({
        type: 'note', body: 'report me', pageUrl: 'https://reports.test/', severity: 'minor',
        target: { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' },
        environment: { browserFamily: 'Chrome', browserVersion: '126', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'test-ua' },
      });
    expect([200, 201]).toContain(created.status);
    const res = await request(live!.app).get('/api/v1/reports/overview').set('Authorization', await bearer(admin));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('1');
    const other = (await live!.seedOrg(['admin'])).actors.admin!;
    const otherRes = await request(live!.app).get('/api/v1/reports/overview').set('Authorization', await bearer(other));
    expect(otherRes.status).toBe(200);
    expect(JSON.stringify(otherRes.body)).not.toEqual(JSON.stringify(res.body));
  });

  it('GET /portals/:slug/info is public, exposes only branding fields, 404s unknown / inactive portals', async ({ skip: s }) => {
    if (skip) return s(skip);
    const slug = `info-${randomUUID().slice(0, 8)}`;
    const created = await request(live!.app).post('/api/v1/portals').set('Authorization', await bearer(admin))
      .send({ projectId, title: 'Acme Portal', slug, welcomeMessage: 'Hi', brandColor: '#112233' });
    expect(created.status).toBe(201);
    const res = await request(live!.app).get(`/api/v1/portals/${slug}/info`);
    expect(res.status).toBe(200);
    expect(res.body.portal).toMatchObject({ title: 'Acme Portal', welcomeMessage: 'Hi', brandColor: '#112233' });
    expect(Object.keys(res.body.portal).sort()).toEqual(
      ['allowNewFeedback', 'brandColor', 'id', 'logoUrl', 'requireEmail', 'title', 'welcomeMessage'],
    );
    expect((await request(live!.app).get('/api/v1/portals/does-not-exist/info')).status).toBe(404);
    await request(live!.app).patch(`/api/v1/portals/${created.body.portal.id}`).set('Authorization', await bearer(admin)).send({ active: false });
    expect((await request(live!.app).get(`/api/v1/portals/${slug}/info`)).status).toBe(404);
  });

  it('POST /integrations/:provider/test: 404 when not connected, ok after a token connect, admin only', async ({ skip: s }) => {
    if (skip) return s(skip);
    // The integrations router is optional; skip if this composition did not mount it.
    const probe = await request(live!.app).get('/api/v1/integrations').set('Authorization', await bearer(admin));
    if (probe.status === 404) return s('integrations router not mounted');
    const none = await request(live!.app).post('/api/v1/integrations/slack/test').set('Authorization', await bearer(admin));
    expect(none.status).toBe(404);
    const connect = await request(live!.app).post('/api/v1/integrations/slack/connect').set('Authorization', await bearer(admin))
      .send({ accessToken: 'xoxb-test-token' });
    expect(connect.status).toBe(201);
    const ok = await request(live!.app).post('/api/v1/integrations/slack/test').set('Authorization', await bearer(admin));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', provider: 'slack', enabled: true });
    const denied = await request(live!.app).post('/api/v1/integrations/slack/test').set('Authorization', await bearer(viewer));
    expect(denied.status).toBe(403);
    await live!.db('integrations').where({ org_id: orgId }).del().catch(() => undefined);
  });
});
