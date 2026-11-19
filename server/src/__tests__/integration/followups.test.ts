// Real-PG integration tests for the security-review follow-ups:
// portal PATCH / slug conflicts / SLA 404 / FK cascade (docs/SECURITY_REVIEW.md).

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
let otherAdmin: LiveActor;

const bearer = async (a: LiveActor) => `Bearer ${await a.token()}`;

describe('Integration: portals / SLA follow-ups', () => {
  beforeAll(async () => {
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    const seeded = await live.seedOrg(['admin', 'viewer']);
    orgId = seeded.orgId; admin = seeded.actors.admin!; viewer = seeded.actors.viewer!;
    otherAdmin = (await live.seedOrg(['admin'])).actors.admin!;
    projectId = await live.seedProject(orgId, admin.id);
  });
  afterAll(async () => { await live?.cleanup(); });

  const createPortal = async (slug: string, actor = admin) =>
    request(live!.app).post('/api/v1/portals').set('Authorization', await bearer(actor))
      .send({ projectId, title: 'Acme', slug });

  it('PATCH /portals/:id updates the allowed fields and returns {portal}', async ({ skip: s }) => {
    if (skip) return s(skip);
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const created = await createPortal(slug);
    expect(created.status).toBe(201);
    const id = created.body.portal.id as string;
    const res = await request(live!.app).patch(`/api/v1/portals/${id}`).set('Authorization', await bearer(admin))
      .send({ title: 'Renamed', welcomeMessage: 'Hello', brandColor: '#112233', logoUrl: 'https://cdn.test/l.png', active: false });
    expect(res.status).toBe(200);
    expect(res.body.portal).toMatchObject({ id, title: 'Renamed', welcome_message: 'Hello', brand_color: '#112233', logo_url: 'https://cdn.test/l.png', active: false });
    const cleared = await request(live!.app).patch(`/api/v1/portals/${id}`).set('Authorization', await bearer(admin))
      .send({ welcomeMessage: null, logoUrl: null });
    expect(cleared.body.portal).toMatchObject({ welcome_message: null, logo_url: null });
  });

  it('PATCH rejects unknown keys, bad colours and non-http logo URLs; viewer 403; other org 404', async ({ skip: s }) => {
    if (skip) return s(skip);
    const created = await createPortal(`p-${randomUUID().slice(0, 8)}`);
    const id = created.body.portal.id as string;
    const patch = async (actor: LiveActor, body: unknown) =>
      request(live!.app).patch(`/api/v1/portals/${id}`).set('Authorization', await bearer(actor)).send(body as object);
    expect((await patch(admin, { slug: 'new-slug' })).status).toBe(400);
    expect((await patch(admin, { org_id: otherAdmin.orgId })).status).toBe(400);
    expect((await patch(admin, { brandColor: 'red' })).status).toBe(400);
    expect((await patch(admin, { logoUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await patch(admin, {})).status).toBe(400);
    expect((await patch(viewer, { title: 'x' })).status).toBe(403);
    expect((await patch(otherAdmin, { title: 'hijack' })).status).toBe(404);
    expect((await live!.db('client_portals').where({ id }).first('title')).title).toBe('Acme');
    const missing = await request(live!.app).patch(`/api/v1/portals/${randomUUID()}`).set('Authorization', await bearer(admin)).send({ title: 'x' });
    expect(missing.status).toBe(404);
  });

  it('duplicate slug → 409 SLUG_TAKEN', async ({ skip: s }) => {
    if (skip) return s(skip);
    const slug = `p-${randomUUID().slice(0, 8)}`;
    expect((await createPortal(slug)).status).toBe(201);
    const dup = await createPortal(slug);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');
  });

  it('DELETE /workflows/sla/:id → 404 when nothing was deleted (unknown or foreign id)', async ({ skip: s }) => {
    if (skip) return s(skip);
    const made = await request(live!.app).post('/api/v1/workflows/sla').set('Authorization', await bearer(admin))
      .send({ name: 'p1', severity: 'critical', responseTimeHours: 1, resolutionTimeHours: 4 });
    expect(made.status).toBe(201);
    const id = made.body.policy.id as string;
    expect((await request(live!.app).delete(`/api/v1/workflows/sla/${id}`).set('Authorization', await bearer(otherAdmin))).status).toBe(404);
    expect(await live!.db('sla_policies').where({ id }).first()).toBeTruthy();
    expect((await request(live!.app).delete(`/api/v1/workflows/sla/${id}`).set('Authorization', await bearer(admin))).status).toBe(204);
    expect((await request(live!.app).delete(`/api/v1/workflows/sla/${id}`).set('Authorization', await bearer(admin))).status).toBe(404);
  });

  it('deleting a project cascades to its portals and project-scoped automation rules (FK)', async ({ skip: s }) => {
    if (skip) return s(skip);
    const pid = await live!.seedProject(orgId, admin.id);
    const portalId = randomUUID(); const ruleId = randomUUID();
    await live!.db('client_portals').insert({ id: portalId, org_id: orgId, project_id: pid, slug: `fk-${portalId.slice(0, 8)}`, title: 't' });
    await live!.db('automation_rules').insert({ id: ruleId, org_id: orgId, project_id: pid, name: 'r', trigger_event: 'annotation.created', action_type: 'notify', action_params: '{}' });
    await live!.db('projects').where({ id: pid }).del();
    expect(await live!.db('client_portals').where({ id: portalId }).first()).toBeUndefined();
    expect(await live!.db('automation_rules').where({ id: ruleId }).first()).toBeUndefined();
    await expect(
      live!.db('client_portals').insert({ org_id: orgId, project_id: randomUUID(), slug: `fk-${randomUUID().slice(0, 8)}`, title: 't' }),
    ).rejects.toThrow();
  });

  it('PP-10: deleting an organisation cascades to its portals, boards, webhooks, SLA policies and rules', async ({ skip: s }) => {
    if (skip) return s(skip);
    const { orgId: doomed, actors } = await live!.seedOrg(['admin']);
    const pid = await live!.seedProject(doomed, actors.admin!.id);
    const ids = { portal: randomUUID(), webhook: randomUUID(), sla: randomUUID(), board: randomUUID() };
    await live!.db('client_portals').insert({ id: ids.portal, org_id: doomed, project_id: pid, slug: `pp10-${ids.portal.slice(0, 8)}`, title: 't' });
    await live!.db('webhook_endpoints').insert({ id: ids.webhook, org_id: doomed, url: 'https://example.com/h', secret: 's', events: ['annotation.created'] });
    await live!.db('sla_policies').insert({ id: ids.sla, org_id: doomed, name: 'p', severity: 'minor', response_time_hours: 1, resolution_time_hours: 2 });
    await live!.db('feedback_boards').insert({ id: ids.board, org_id: doomed, project_id: pid, slug: `pp10-${ids.board.slice(0, 8)}`, title: 'b' });
    await live!.db('projects').where({ org_id: doomed }).del();
    await live!.db('memberships').where({ org_id: doomed }).del();
    await live!.db('organizations').where({ id: doomed }).del();
    for (const [table, id] of [['client_portals', ids.portal], ['webhook_endpoints', ids.webhook], ['sla_policies', ids.sla], ['feedback_boards', ids.board]] as const) {
      expect(await live!.db(table).where({ id }).first(), table).toBeUndefined();
    }
  });
});
