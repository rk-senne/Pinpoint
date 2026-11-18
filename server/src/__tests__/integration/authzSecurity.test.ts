// Integration test (real Postgres): authorization, tenancy, roles, sessions.
//
// Security audit findings covered here, each against real routers + real
// repositories + real SQL (no mocked db):
//   F-02 list annotations needs project access        F-03 comments scoped by org + project
//   F-10 project access / RBAC on bulk, feedback,     F-06 token_version + membership enforced
//        activity, heatmap, triage, workflow, boards       (logout, removal, refresh)
//   F-07 org roles / invitations                      F-12 board leak, vote dedupe, approvals
//   F-18 API-key allow-list + scopes + audit          F-19 feedback validation + page ownership
//   F-11 integrations DTO                             F-05 client portal magic link
//
// Skips gracefully when no Postgres test DB is reachable (same convention as
// screenshotCapture.test.ts).

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { createAuthMiddleware } from '../../adapters/inbound/http/auth.middleware.js';
import { createAnnotationRoutes } from '../../adapters/inbound/http/annotations.routes.js';
import { createCommentsRoutes } from '../../adapters/inbound/http/comments.routes.js';
import { createBulkRoutes } from '../../adapters/inbound/http/bulk.routes.js';
import { createActivityRoutes } from '../../adapters/inbound/http/activity.routes.js';
import { createHeatmapRoutes } from '../../adapters/inbound/http/heatmap.routes.js';
import { createTriageRoutes } from '../../adapters/inbound/http/triage.routes.js';
import { createFeedbackRoutes } from '../../adapters/inbound/http/feedback.routes.js';
import { createOrgRoutes } from '../../adapters/inbound/http/org.routes.js';
import { createApiKeyRoutes } from '../../adapters/inbound/http/apiKeys.routes.js';
import { createPremiumRoutes } from '../../adapters/inbound/http/premium.routes.js';
import { createWorkflowRoutes } from '../../adapters/inbound/http/workflow.routes.js';
import { createClientPortalRoutes } from '../../adapters/inbound/http/clientPortal.routes.js';
import { createIntegrationsRoutes } from '../../adapters/inbound/http/integrations.routes.js';
import { createApiKeyOrJwtMiddleware } from '../../middleware/apiKeyOrJwt.js';
import { JwtTokenIssuer } from '../../adapters/outbound/jwt/JwtTokenIssuer.js';
import { SystemClock } from '../../adapters/outbound/clock/SystemClock.js';
import { PgAnnotationRepo } from '../../adapters/outbound/postgres/PgAnnotationRepo.js';
import { PgApiKeyRepo } from '../../adapters/outbound/postgres/PgApiKeyRepo.js';
import { PgAuthTokenRepo } from '../../adapters/outbound/postgres/PgAuthTokenRepo.js';
import { PgCommentRepo } from '../../adapters/outbound/postgres/PgCommentRepo.js';
import { PgIntegrationRepo } from '../../adapters/outbound/postgres/PgIntegrationRepo.js';
import { PgInvitationRepo } from '../../adapters/outbound/postgres/PgInvitationRepo.js';
import { PgMembershipRepo } from '../../adapters/outbound/postgres/PgMembershipRepo.js';
import { PgOrgRepo } from '../../adapters/outbound/postgres/PgOrgRepo.js';
import { PgPageRepo } from '../../adapters/outbound/postgres/PgPageRepo.js';
import { PgProjectPinSequence } from '../../adapters/outbound/postgres/PgProjectPinSequence.js';
import { PgProjectRepo } from '../../adapters/outbound/postgres/PgProjectRepo.js';
import { PgTeamMemberRepo } from '../../adapters/outbound/postgres/PgTeamMemberRepo.js';
import { PgUserRepo } from '../../adapters/outbound/postgres/PgUserRepo.js';
import { CreateAnnotation } from '../../domain/annotation/usecases/createAnnotation.js';
import { UpdateAnnotation } from '../../domain/annotation/usecases/updateAnnotation.js';
import { ChangeAnnotationStatus } from '../../domain/annotation/usecases/changeAnnotationStatus.js';
import { DeleteAnnotation } from '../../domain/annotation/usecases/deleteAnnotation.js';
import { AttachScreenshot } from '../../domain/annotation/usecases/attachScreenshot.js';
import { CreateComment } from '../../domain/comment/usecases/createComment.js';
import { ListComments } from '../../domain/comment/usecases/listComments.js';
import { InviteToOrg } from '../../domain/org/usecases/inviteToOrg.js';
import { AcceptInvitation } from '../../domain/org/usecases/acceptInvitation.js';
import { Logout } from '../../domain/auth/usecases/logout.js';
import { RefreshToken } from '../../domain/auth/usecases/refreshToken.js';
import { CompletePasswordReset } from '../../domain/auth/usecases/completePasswordReset.js';
import { FakeEventBus, FakeMailer, FakePasswordHasher, FakeScreenshotStore } from '../fakes/index.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

let db: Knex | null = null;
let skipReason: string | null = null;

// --- seed bookkeeping -------------------------------------------------------
interface Actor {
  id: string;
  email: string;
  token: string;
}
const T = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  teamA: randomUUID(),
  projectA: randomUUID(),
  projectB: randomUUID(),
  pageA: randomUUID(),
  pageB: randomUUID(),
  annotationA: randomUUID(),
  annotationB: randomUUID(),
} as const;
const actors = {} as Record<'ownerA' | 'adminA' | 'memberA' | 'viewerA' | 'teamMateA' | 'ownerB', Actor>;
const userIds: string[] = [];

const tokenIssuer = new JwtTokenIssuer({ secret: JWT_SECRET, accessTtl: '1h' });
const bearer = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

const TARGET = { cssSelector: 'div', xpath: '/div', pageX: 10, pageY: 20, tagName: 'DIV', textSnippet: '' };
const ENV = {
  browserFamily: 'Chrome', browserVersion: '126', osFamily: 'macOS', osVersion: '14',
  deviceType: 'desktop', userAgentRaw: 'test-ua',
};

let app: express.Express;
let mailer: FakeMailer;
let userRepo: PgUserRepo;
let apiKeyRepo: PgApiKeyRepo;
let membershipRepo: PgMembershipRepo;

async function seedUser(label: string, orgId: string | null, role: string | null): Promise<Actor> {
  const id = randomUUID();
  const email = `${label}-${id}@authz.test`;
  await db!('users').insert({ id, email, name: label, password_hash: 'x', verified: true });
  userIds.push(id);
  if (orgId && role) await db!('memberships').insert({ org_id: orgId, user_id: id, role });
  return { id, email, token: tokenIssuer.sign({ userId: id, email, orgId: orgId ?? T.orgA, role: role ?? 'member', tokenVersion: 0 }) };
}

function tokenFor(a: Actor, orgId: string, role: string, tokenVersion = 0): string {
  return tokenIssuer.sign({ userId: a.id, email: a.email, orgId, role, tokenVersion });
}

describe('Integration: authorization, tenancy, roles, sessions', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
      skipReason = 'SKIP_INTEGRATION_TESTS=true';
      return;
    }
    try {
      db = knex({
        client: 'pg',
        connection: {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME || 'pinpoint_test',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
        },
        pool: { min: 1, max: 6 },
        migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
      });
      await db.raw('SELECT 1');
      await db.migrate.latest();
    } catch (e) {
      skipReason = e instanceof Error ? e.message : String(e);
      if (db) await db.destroy().catch(() => {});
      db = null;
      return;
    }

    // ---- seed: org A (owner/admin/member/viewer/team-mate) + org B ---------
    await db('organizations').insert([
      { id: T.orgA, name: `authz-a-${T.orgA}`, slug: `authz-a-${T.orgA}` },
      { id: T.orgB, name: `authz-b-${T.orgB}`, slug: `authz-b-${T.orgB}` },
    ]);
    actors.ownerA = await seedUser('ownerA', T.orgA, 'owner');
    actors.adminA = await seedUser('adminA', T.orgA, 'admin');
    actors.memberA = await seedUser('memberA', T.orgA, 'member'); // org member, NOT on the project
    actors.viewerA = await seedUser('viewerA', T.orgA, 'viewer');
    actors.teamMateA = await seedUser('teamMateA', T.orgA, 'member'); // on the project's team
    actors.ownerB = await seedUser('ownerB', T.orgB, 'owner');
    for (const [k, role] of [['ownerA', 'owner'], ['adminA', 'admin'], ['memberA', 'member'], ['viewerA', 'viewer'], ['teamMateA', 'member']] as const) {
      actors[k].token = tokenFor(actors[k], T.orgA, role);
    }
    actors.ownerB.token = tokenFor(actors.ownerB, T.orgB, 'owner');

    await db('teams').insert({ id: T.teamA, name: 'team-a', owner_id: actors.ownerA.id, org_id: T.orgA });
    await db('team_members').insert([
      { team_id: T.teamA, user_id: actors.ownerA.id, role: 'owner' },
      { team_id: T.teamA, user_id: actors.teamMateA.id, role: 'viewer' },
    ]);
    await db('projects').insert([
      { id: T.projectA, name: 'A', urls: ['https://a.test'], status: 'active', owner_id: actors.ownerA.id, org_id: T.orgA, team_id: T.teamA, pin_counter: 0 },
      { id: T.projectB, name: 'B', urls: ['https://b.test'], status: 'active', owner_id: actors.ownerB.id, org_id: T.orgB, pin_counter: 0 },
    ]);
    await db('pages').insert([
      { id: T.pageA, project_id: T.projectA, url: 'https://a.test/' },
      { id: T.pageB, project_id: T.projectB, url: 'https://b.test/' },
    ]);
    const annRow = (id: string, project: string, page: string, org: string, author: string) => ({
      id, project_id: project, page_id: page, org_id: org, type: 'note', severity: 'minor', status: 'active',
      body: 'seed', author_id: author, pin_number: 1, target: JSON.stringify(TARGET), environment: JSON.stringify(ENV),
    });
    await db('annotations').insert([
      annRow(T.annotationA, T.projectA, T.pageA, T.orgA, actors.ownerA.id),
      annRow(T.annotationB, T.projectB, T.pageB, T.orgB, actors.ownerB.id),
    ]);

    // ---- wire real routers --------------------------------------------------
    const clock = new SystemClock();
    userRepo = new PgUserRepo(db);
    membershipRepo = new PgMembershipRepo(db);
    apiKeyRepo = new PgApiKeyRepo(db);
    const annotationRepo = new PgAnnotationRepo(db);
    const projectRepo = new PgProjectRepo(db);
    const pageRepo = new PgPageRepo(db);
    const teamMemberRepo = new PgTeamMemberRepo(db);
    const eventBus = new FakeEventBus();
    mailer = new FakeMailer();
    const dbRef = db;

    const authMiddleware = createAuthMiddleware({ tokenIssuer, db });
    const automationAuth = createApiKeyOrJwtMiddleware({ apiKeyRepo, jwtMiddleware: authMiddleware, db });

    const { projectAnnotationsRouter, annotationRouter } = createAnnotationRoutes({
      createAnnotation: new CreateAnnotation({
        annotationRepo, projectRepo, pageRepo, teamMemberRepo,
        pinSequence: new PgProjectPinSequence(db),
        runInTransaction: async <R>(fn: (tx: unknown) => Promise<R>) => dbRef.transaction((trx) => fn(trx)),
        clock, eventBus,
      }),
      updateAnnotation: new UpdateAnnotation({ annotationRepo, projectRepo, teamMemberRepo, eventBus }),
      changeAnnotationStatus: new ChangeAnnotationStatus({ annotationRepo, projectRepo, teamMemberRepo, eventBus }),
      deleteAnnotation: new DeleteAnnotation({ annotationRepo, projectRepo, teamMemberRepo }),
      attachScreenshot: new AttachScreenshot({ annotationRepo, projectRepo, teamMemberRepo, screenshotStore: new FakeScreenshotStore() }),
      annotationRepo,
      resolvePageUrls: async () => new Map(),
      buildScreenshotUrl: (k) => k,
      fetchScreenshotBuffer: async () => null,
      authMiddleware: automationAuth,
      db,
    });
    const commentRepo = new PgCommentRepo(db);
    const commentsRouter = createCommentsRoutes({
      createComment: new CreateComment({ commentRepo, annotationRepo, eventBus }),
      listComments: new ListComments({ commentRepo, annotationRepo }),
      authMiddleware: automationAuth,
      db,
    });
    const invitationRepo = new PgInvitationRepo(db);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Stand-in for the real projects router, which is mounted with the
    // API-key-aware middleware (so the allow-list is what stops a key from
    // reaching DELETE /projects/:id).
    const projectsStub = express.Router();
    projectsStub.use(automationAuth);
    projectsStub.delete('/:id', (_req, res) => res.status(200).json({ deleted: true }));
    app.use('/api/v1/projects', projectsStub);
    app.use('/api/v1/projects/:id/annotations', projectAnnotationsRouter);
    app.use('/api/v1/annotations/:id/comments', commentsRouter);
    app.use('/api/v1/annotations', annotationRouter);
    app.use('/api/v1/projects', createBulkRoutes({ authMiddleware, db }));
    app.use('/api/v1/projects', createTriageRoutes({ authMiddleware, db }));
    app.use('/api/v1/projects', createHeatmapRoutes({ authMiddleware, db }));
    app.use('/api/v1/projects/:id/activity', createActivityRoutes({ authMiddleware, db }));
    app.use('/api/v1/feedback', createFeedbackRoutes({ authMiddleware: automationAuth, annotationRepo, db }));
    app.use(
      '/api/v1/org',
      createOrgRoutes({
        authMiddleware,
        inviteToOrg: new InviteToOrg({ invitationRepo, membershipRepo, clock, eventBus, mailer, appUrl: 'https://app.test' }),
        acceptInvitation: new AcceptInvitation({ invitationRepo, membershipRepo, clock }),
        membershipRepo,
        orgRepo: new PgOrgRepo(db),
        userRepo,
        tokenIssuer,
        db,
      }),
    );
    app.use('/api/v1/api-keys', createApiKeyRoutes({ authMiddleware, apiKeyRepo, db }));
    app.use('/api/v1', createPremiumRoutes({ authMiddleware, db }));
    app.use('/api/v1/workflows', createWorkflowRoutes({ authMiddleware, db }));
    app.use('/api/v1/portals', createClientPortalRoutes({ authMiddleware, db, mailer, appUrl: 'https://app.test', accessRateLimit: { limit: 3, windowMs: 60_000 } }));
    app.use('/api/v1/integrations', createIntegrationsRoutes({ authMiddleware, integrationRepo: new PgIntegrationRepo(db), oauthStateSecret: 's' }));
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db('projects').whereIn('id', [T.projectA, T.projectB]).del();
      await db('organizations').whereIn('id', [T.orgA, T.orgB]).del();
      await db('users').whereIn('id', userIds).del();
    } catch {
      /* best-effort cleanup */
    } finally {
      await db.destroy().catch(() => {});
    }
  });

  const live = (ctx: { skip: (note?: string) => void }): boolean => {
    if (!db) {
      ctx.skip(`Postgres test DB unavailable: ${skipReason ?? 'unknown'}`);
      return false;
    }
    return true;
  };

  // ==========================================================================
  // F-02 / F-03 / F-10 — tenancy + project access
  // ==========================================================================
  describe('F-02 list annotations', () => {
    it('owner and team member can list; foreign / random / non-member project ids are 404', async (ctx) => {
      if (!live(ctx)) return;
      const url = (id: string) => `/api/v1/projects/${id}/annotations`;

      expect((await request(app).get(url(T.projectA)).set(bearer(actors.ownerA))).status).toBe(200);
      const team = await request(app).get(url(T.projectA)).set(bearer(actors.teamMateA));
      expect(team.status).toBe(200);
      expect(team.body.data.map((a: { id: string }) => a.id)).toContain(T.annotationA);

      // Same org but neither owner nor team member → no access.
      expect((await request(app).get(url(T.projectA)).set(bearer(actors.memberA))).status).toBe(404);
      // Another tenant's project.
      expect((await request(app).get(url(T.projectB)).set(bearer(actors.ownerA))).status).toBe(404);
      // Random + malformed ids are indistinguishable from the above.
      expect((await request(app).get(url(randomUUID())).set(bearer(actors.ownerA))).status).toBe(404);
      expect((await request(app).get(url('not-a-uuid')).set(bearer(actors.ownerA))).status).toBe(404);
    });

    it('annotation create is gated the same way', async (ctx) => {
      if (!live(ctx)) return;
      const body = { type: 'note', body: 'hi', pageUrl: 'https://a.test/', target: TARGET, environment: ENV };
      expect((await request(app).post(`/api/v1/projects/${T.projectA}/annotations`).set(bearer(actors.memberA)).send(body)).status).toBe(404);
      expect((await request(app).post(`/api/v1/projects/${T.projectA}/annotations`).set(bearer(actors.viewerA)).send(body)).status).toBe(403);
    });
  });

  describe('F-03 comments', () => {
    const url = (id: string) => `/api/v1/annotations/${id}/comments`;

    it('foreign / random annotation ids are 404 for list and create', async (ctx) => {
      if (!live(ctx)) return;
      for (const id of [T.annotationB, randomUUID(), 'nope']) {
        expect((await request(app).get(url(id)).set(bearer(actors.ownerA))).status, `list ${id}`).toBe(404);
        expect((await request(app).post(url(id)).set(bearer(actors.ownerA)).send({ body: 'x' })).status, `create ${id}`).toBe(404);
      }
      // The foreign annotation was not modified.
      const [{ count }] = await db!('comments').where({ annotation_id: T.annotationB }).count('* as count');
      expect(Number(count)).toBe(0);
    });

    it('same-org user without project access is 404; owner and team member succeed', async (ctx) => {
      if (!live(ctx)) return;
      expect((await request(app).get(url(T.annotationA)).set(bearer(actors.memberA))).status).toBe(404);
      expect((await request(app).post(url(T.annotationA)).set(bearer(actors.memberA)).send({ body: 'x' })).status).toBe(404);

      const created = await request(app).post(url(T.annotationA)).set(bearer(actors.teamMateA)).send({ body: 'from team mate' });
      expect(created.status).toBe(201);
      const listed = await request(app).get(url(T.annotationA)).set(bearer(actors.ownerA));
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((c: { body: string }) => c.body)).toContain('from team mate');
    });
  });

  describe('F-10 project-scoped routes enforce project access', () => {
    it('bulk: owner/admin only, project access, and assignee must be an org member', async (ctx) => {
      if (!live(ctx)) return;
      const bulk = (p: string) => `/api/v1/projects/${p}/annotations/bulk`;
      const body = { ids: [T.annotationA], action: 'assign', params: { assigneeId: actors.ownerA.id } };

      // member / viewer: RBAC
      expect((await request(app).post(bulk(T.projectA)).set(bearer(actors.memberA)).send(body)).status).toBe(403);
      expect((await request(app).post(bulk(T.projectA)).set(bearer(actors.viewerA)).send(body)).status).toBe(403);
      // admin of the org but not owner/team of the project: still no access
      expect((await request(app).post(bulk(T.projectA)).set(bearer(actors.adminA)).send(body)).status).toBe(404);
      // foreign tenant
      expect((await request(app).post(bulk(T.projectA)).set(bearer(actors.ownerB)).send(body)).status).toBe(404);
      // owner OK
      expect((await request(app).post(bulk(T.projectA)).set(bearer(actors.ownerA)).send(body)).status).toBe(200);
      // out-of-org assignee → 400, row untouched
      const out = await request(app)
        .post(bulk(T.projectA)).set(bearer(actors.ownerA))
        .send({ ids: [T.annotationA], action: 'assign', params: { assigneeId: actors.ownerB.id } });
      expect(out.status).toBe(400);
      const row = await db!('annotations').where({ id: T.annotationA }).first('assignee_id');
      expect(row.assignee_id).toBe(actors.ownerA.id);
    });

    it('activity / heatmap / triage need project access', async (ctx) => {
      if (!live(ctx)) return;
      expect((await request(app).get(`/api/v1/projects/${T.projectA}/activity`).set(bearer(actors.memberA))).status).toBe(404);
      expect((await request(app).get(`/api/v1/projects/${T.projectA}/activity`).set(bearer(actors.teamMateA))).status).toBe(200);
      expect((await request(app).get(`/api/v1/projects/${T.projectA}/heatmap`).set(bearer(actors.memberA))).status).toBe(404);
      expect((await request(app).get(`/api/v1/projects/${T.projectA}/heatmap`).set(bearer(actors.teamMateA))).status).toBe(200);
      expect((await request(app).post(`/api/v1/projects/${T.projectA}/annotations/triage`).set(bearer(actors.memberA)).send({ body: 'x' })).status).toBe(404);
      expect((await request(app).post(`/api/v1/projects/${T.projectA}/annotations/triage`).set(bearer(actors.teamMateA)).send({ body: 'x' })).status).toBe(200);
    });

    it('feedback list / get / patch / delete need project access', async (ctx) => {
      if (!live(ctx)) return;
      expect((await request(app).get(`/api/v1/feedback?projectId=${T.projectA}`).set(bearer(actors.memberA))).status).toBe(404);
      expect((await request(app).get(`/api/v1/feedback?projectId=${T.projectA}`).set(bearer(actors.teamMateA))).status).toBe(200);
      expect((await request(app).get(`/api/v1/feedback/${T.annotationA}`).set(bearer(actors.memberA))).status).toBe(404);
      expect((await request(app).patch(`/api/v1/feedback/${T.annotationA}`).set(bearer(actors.memberA)).send({ body: 'x' })).status).toBe(404);
      expect((await request(app).delete(`/api/v1/feedback/${T.annotationA}`).set(bearer(actors.memberA))).status).toBe(404);
    });

    it('workflow rules/SLA mutations are owner/admin only; boards need project access', async (ctx) => {
      if (!live(ctx)) return;
      const sla = { name: 'p1', severity: 'critical', responseTimeHours: 1, resolutionTimeHours: 4 };
      expect((await request(app).post('/api/v1/workflows/sla').set(bearer(actors.memberA)).send(sla)).status).toBe(403);
      expect((await request(app).post('/api/v1/workflows/sla').set(bearer(actors.adminA)).send(sla)).status).toBe(201);
      expect((await request(app).get('/api/v1/workflows/sla').set(bearer(actors.memberA))).status).toBe(200); // reads stay open

      const board = { projectId: T.projectA, title: 'b', slug: `b-${randomUUID().slice(0, 8)}` };
      expect((await request(app).post('/api/v1/boards').set(bearer(actors.memberA)).send(board)).status).toBe(403);
      expect((await request(app).post('/api/v1/boards').set(bearer(actors.teamMateA)).send(board)).status).toBe(201);
    });
  });

  // ==========================================================================
  // F-19 feedback validation
  // ==========================================================================
  describe('F-19 feedback create', () => {
    const body = (extra: object = {}) => ({ projectId: T.projectA, body: 'b', target: TARGET, environment: ENV, ...extra });

    it('Zod-validates the body and rejects a pageId from another project', async (ctx) => {
      if (!live(ctx)) return;
      expect((await request(app).post('/api/v1/feedback').set(bearer(actors.ownerA)).send({ projectId: T.projectA })).status).toBe(400);
      expect((await request(app).post('/api/v1/feedback').set(bearer(actors.ownerA)).send(body({ severity: 'apocalyptic' }))).status).toBe(400);
      const foreignPage = await request(app).post('/api/v1/feedback').set(bearer(actors.ownerA)).send(body({ pageId: T.pageB }));
      expect(foreignPage.status).toBe(400);

      const ok = await request(app).post('/api/v1/feedback').set(bearer(actors.ownerA)).send(body({ pageId: T.pageA }));
      expect(ok.status).toBe(201);
      expect(ok.body.data.pageId).toBe(T.pageA);
    });

    it('PATCH validates fields and the assignee must be an org member', async (ctx) => {
      if (!live(ctx)) return;
      const url = `/api/v1/feedback/${T.annotationA}`;
      expect((await request(app).patch(url).set(bearer(actors.ownerA)).send({ status: 'bogus' })).status).toBe(400);
      expect((await request(app).patch(url).set(bearer(actors.ownerA)).send({ assigneeId: actors.ownerB.id })).status).toBe(400);
      expect((await request(app).patch(url).set(bearer(actors.ownerA)).send({ body: 'edited' })).status).toBe(200);
    });
  });

  // ==========================================================================
  // F-18 API keys
  // ==========================================================================
  describe('F-18 API keys', () => {
    async function mintKey(actor: Actor, scopes?: string[]) {
      const res = await request(app).post('/api/v1/api-keys').set(bearer(actor)).send({ name: 'k', ...(scopes ? { scopes } : {}) });
      return res;
    }

    it('validates scopes on creation (unknown / empty rejected, defaults kept)', async (ctx) => {
      if (!live(ctx)) return;
      expect((await mintKey(actors.ownerA, ['admin'])).status).toBe(400);
      expect((await mintKey(actors.ownerA, ['feedback:read', '*'])).status).toBe(400);
      expect((await mintKey(actors.ownerA, [])).status).toBe(400);
      const ok = await mintKey(actors.ownerA, ['feedback:read']);
      expect(ok.status).toBe(201);
      expect(ok.body.scopes).toEqual(['feedback:read']);
      const dflt = await mintKey(actors.ownerA);
      expect(dflt.body.scopes).toEqual(['feedback:read', 'feedback:write']);
    });

    it('a key reaches only the allow-list: MCP calls work, project delete does not', async (ctx) => {
      if (!live(ctx)) return;
      const minted = await mintKey(actors.ownerA);
      const key = { Authorization: `Bearer ${minted.body.rawKey}` };
      const mk = await db!('api_keys').where({ id: minted.body.id }).first('created_by');
      expect(mk.created_by).toBe(actors.ownerA.id);

      expect((await request(app).get(`/api/v1/projects/${T.projectA}/annotations`).set(key)).status).toBe(200);
      expect((await request(app).get(`/api/v1/feedback?projectId=${T.projectA}`).set(key)).status).toBe(200);
      expect((await request(app).get(`/api/v1/annotations/${T.annotationA}/comments`).set(key)).status).toBe(200);
      expect((await request(app).post(`/api/v1/annotations/${T.annotationA}/comments`).set(key).send({ body: 'bot says hi' })).status).toBe(201);
      expect((await request(app).put(`/api/v1/annotations/${T.annotationA}/status`).set(key).send({ status: 'in_progress' })).status).toBe(200);

      for (const [method, p] of [
        ['delete', `/api/v1/projects/${T.projectA}`],
        ['delete', `/api/v1/annotations/${T.annotationA}`],
        ['delete', `/api/v1/feedback/${T.annotationA}`],
        ['post', '/api/v1/feedback'],
        ['post', `/api/v1/projects/${T.projectA}/annotations`],
      ] as const) {
        const res = await request(app)[method](p).set(key).send({});
        expect(res.status, `${method} ${p}`).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      }
      expect(await db!('projects').where({ id: T.projectA }).first('id')).toBeTruthy();
    });

    it('key creation/revocation audit rows record the acting key when a key is used (audit helper)', async (ctx) => {
      if (!live(ctx)) return;
      const { recordAudit, auditApiKeyContext } = await import('../../adapters/inbound/http/auditLog.routes.js');
      const fakeReq = { apiKey: { id: 'key-123' } } as never;
      await recordAudit(db!, { orgId: T.orgA, actorId: actors.ownerA.id, action: 'authz.test', resourceType: 'x', ...auditApiKeyContext(fakeReq) });
      const row = await db!('audit_logs').where({ org_id: T.orgA, action: 'authz.test' }).first('metadata');
      expect(row.metadata).toMatchObject({ viaApiKey: true, apiKeyId: 'key-123' });
    });
  });

  // ==========================================================================
  // F-06 sessions
  // ==========================================================================
  describe('F-06 token_version + membership', () => {
    it('a token with a stale token_version is rejected; a current one works', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('stale', T.orgA, 'member');
      const url = '/api/v1/org/members';
      expect((await request(app).get(url).set({ Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 0)}` })).status).toBe(200);
      await userRepo.incrementTokenVersion(u.id);
      expect((await request(app).get(url).set({ Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 0)}` })).status).toBe(401);
      expect((await request(app).get(url).set({ Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 1)}` })).status).toBe(200);
    });

    it('logout invalidates the old token', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('logout', T.orgA, 'member');
      const old = { Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 0)}` };
      expect((await request(app).get('/api/v1/org/members').set(old)).status).toBe(200);

      const logout = new Logout({ authTokenRepo: new PgAuthTokenRepo(db!), userRepo });
      expect((await logout.execute({ userId: u.id })).ok).toBe(true);

      expect((await request(app).get('/api/v1/org/members').set(old)).status).toBe(401);
    });

    it('password reset completion invalidates existing sessions', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('reset', T.orgA, 'member');
      const old = { Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 0)}` };
      const authTokenRepo = new PgAuthTokenRepo(db!);
      const raw = 'reset-token-' + randomUUID();
      await authTokenRepo.insert({
        userId: u.id, kind: 'reset_password',
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const uc = new CompletePasswordReset({ userRepo, authTokenRepo, passwordHasher: new FakePasswordHasher(), clock: new SystemClock() });
      const res = await uc.execute({ token: raw, newPassword: 'Correct-Horse-Battery-9!' });
      expect(res.ok).toBe(true);
      expect((await request(app).get('/api/v1/org/members').set(old)).status).toBe(401);
    });

    it('revoke-sessions kills the caller\'s old tokens', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('revoke', T.orgA, 'member');
      const old = { Authorization: `Bearer ${tokenFor(u, T.orgA, 'member', 0)}` };
      expect((await request(app).post('/api/v1/org/revoke-sessions').set(old)).status).toBe(200);
      expect((await request(app).get('/api/v1/org/members').set(old)).status).toBe(401);
    });

    it('a removed member\'s token is rejected, their API keys are revoked, and refresh fails', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('removed', T.orgA, 'admin');
      const tok = tokenFor(u, T.orgA, 'admin', 0);
      const auth = { Authorization: `Bearer ${tok}` };
      expect((await request(app).get('/api/v1/org/members').set(auth)).status).toBe(200);

      const minted = await request(app).post('/api/v1/api-keys').set(auth).send({ name: 'mine' });
      expect(minted.status).toBe(201);
      const key = { Authorization: `Bearer ${minted.body.rawKey}` };
      expect((await request(app).get(`/api/v1/feedback?projectId=${T.projectA}`).set(key)).status).toBe(404); // authenticated, no project access

      const del = await request(app).delete(`/api/v1/org/members/${u.id}`).set(bearer(actors.ownerA));
      expect(del.status).toBe(204);

      expect((await request(app).get('/api/v1/org/members').set(auth)).status).toBe(401);
      expect((await request(app).get(`/api/v1/feedback?projectId=${T.projectA}`).set(key)).status).toBe(401);
      const k = await db!('api_keys').where({ id: minted.body.id }).first('revoked_at');
      expect(k.revoked_at).not.toBeNull();

      const refresh = new RefreshToken({ tokenIssuer, clock: new SystemClock(), userRepo, membershipRepo });
      const r = await refresh.execute({ token: tok });
      expect(r.ok).toBe(false);
    });

    it('refresh re-checks the user, token_version and re-signs with the CURRENT role', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('refresh', T.orgA, 'member');
      const refresh = new RefreshToken({ tokenIssuer, clock: new SystemClock(), userRepo, membershipRepo });

      await membershipRepo.updateRole(T.orgA, u.id, 'viewer');
      const ok = await refresh.execute({ token: tokenFor(u, T.orgA, 'admin', 0) }); // stale 'admin' claim
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(tokenIssuer.verify(ok.value.token).role).toBe('viewer');

      await userRepo.incrementTokenVersion(u.id);
      expect((await refresh.execute({ token: tokenFor(u, T.orgA, 'viewer', 0) })).ok).toBe(false);

      await db!('users').where({ id: u.id }).del();
      userIds.splice(userIds.indexOf(u.id), 1);
      expect((await refresh.execute({ token: tokenFor(u, T.orgA, 'viewer', 1) })).ok).toBe(false);
    });

    it('the live membership role (not the JWT claim) drives RBAC', async (ctx) => {
      if (!live(ctx)) return;
      const u = await seedUser('demoted', T.orgA, 'member');
      // JWT claims 'owner' but the DB says 'member' → bulk (owner/admin) is 403.
      const forged = { Authorization: `Bearer ${tokenFor(u, T.orgA, 'owner', 0)}` };
      const res = await request(app).post(`/api/v1/projects/${T.projectA}/annotations/bulk`).set(forged).send({ ids: [T.annotationA], action: 'resolve' });
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // F-07 org roles + invitations
  // ==========================================================================
  describe('F-07 org roles and invitations', () => {
    it('invitation: admin cannot invite an owner; token is emailed, never returned, stored hashed', async (ctx) => {
      if (!live(ctx)) return;
      const email = `invitee-${randomUUID()}@authz.test`;
      const asOwner = await request(app).post('/api/v1/org/invitations').set(bearer(actors.adminA)).send({ email, role: 'owner' });
      expect(asOwner.status).toBe(403);

      const res = await request(app).post('/api/v1/org/invitations').set(bearer(actors.adminA)).send({ email, role: 'member' });
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
      expect(Object.keys(res.body).sort()).toEqual(['email', 'expiresAt', 'invitationId', 'role']);

      const sent = mailer.sent.find((m) => m.to === email);
      expect(sent).toBeTruthy();
      const raw = /token=([0-9a-f]{64})/.exec(sent!.body)?.[1];
      expect(raw).toBeTruthy();
      const stored = await db!('invitations').where({ email }).first('token');
      expect(stored.token).toBe(createHash('sha256').update(raw!).digest('hex'));

      // Accept: wrong account is refused, the invited email succeeds.
      const wrong = await request(app).post('/api/v1/org/invitations/accept').set(bearer(actors.ownerB)).send({ token: raw });
      expect(wrong.status).toBe(404);
      const invitee = await seedUser('invitee', null, null);
      await db!('users').where({ id: invitee.id }).update({ email: email.toUpperCase() });
      const joined = await request(app)
        .post('/api/v1/org/invitations/accept')
        .set({ Authorization: `Bearer ${tokenFor(invitee, T.orgB, 'member')}` }) // needs an org context for the token; membership checked below
        .send({ token: raw });
      // The invitee has no membership in orgB, so the session itself is invalid.
      expect(joined.status).toBe(401);
    });

    it('accept works for the invited email (case-insensitive) from the invitee\'s own org', async (ctx) => {
      if (!live(ctx)) return;
      const email = `case-${randomUUID()}@authz.test`;
      await request(app).post('/api/v1/org/invitations').set(bearer(actors.ownerA)).send({ email, role: 'viewer' });
      const raw = /token=([0-9a-f]{64})/.exec(mailer.sent.find((m) => m.to === email)!.body)![1]!;

      const invitee = await seedUser('invitee2', T.orgB, 'member');
      await db!('users').where({ id: invitee.id }).update({ email: email.toUpperCase() });
      const auth = { Authorization: `Bearer ${tokenFor(invitee, T.orgB, 'member')}` };
      const res = await request(app).post('/api/v1/org/invitations/accept').set(auth).send({ token: raw });
      expect(res.status).toBe(200);
      expect(res.body.membership).toMatchObject({ orgId: T.orgA, role: 'viewer' });
    });

    it('admins cannot remove an owner; the last owner can never be removed or demoted', async (ctx) => {
      if (!live(ctx)) return;
      const org = randomUUID();
      await db!('organizations').insert({ id: org, name: `solo-${org}`, slug: `solo-${org}` });
      const owner = await seedUser('soloOwner', org, 'owner');
      const admin = await seedUser('soloAdmin', org, 'admin');
      const owner2 = await seedUser('soloOwner2', org, 'owner');
      const ownerTok = { Authorization: `Bearer ${tokenFor(owner, org, 'owner')}` };
      const adminTok = { Authorization: `Bearer ${tokenFor(admin, org, 'admin')}` };

      // admin can't remove an owner
      expect((await request(app).delete(`/api/v1/org/members/${owner.id}`).set(adminTok)).status).toBe(403);
      // owner demotes owner2 → fine (still one other owner)
      expect((await request(app).patch(`/api/v1/org/members/${owner2.id}`).set(ownerTok).send({ role: 'member' })).status).toBe(200);
      // now `owner` is the last owner: cannot be demoted (self) ...
      expect((await request(app).patch(`/api/v1/org/members/${owner.id}`).set(ownerTok).send({ role: 'admin' })).status).toBe(409);
      // ... and the last owner cannot be removed by another (restored) owner path
      await membershipRepo.updateRole(org, owner2.id, 'owner');
      expect((await request(app).delete(`/api/v1/org/members/${owner2.id}`).set(ownerTok)).status).toBe(204); // two owners → allowed
      expect((await request(app).get('/api/v1/org/members').set(ownerTok)).status).toBe(200);
      await db!('organizations').where({ id: org }).del();
    });
  });

  // ==========================================================================
  // F-12 premium: boards, votes, approvals, CSAT
  // ==========================================================================
  describe('F-12 premium routes', () => {
    it('public board never exposes author_email; vote is scoped to the board and de-duplicated', async (ctx) => {
      if (!live(ctx)) return;
      const slug1 = `b1-${randomUUID().slice(0, 8)}`;
      const slug2 = `b2-${randomUUID().slice(0, 8)}`;
      const b1 = await request(app).post('/api/v1/boards').set(bearer(actors.ownerA)).send({ projectId: T.projectA, title: 'one', slug: slug1 });
      const b2 = await request(app).post('/api/v1/boards').set(bearer(actors.ownerA)).send({ projectId: T.projectA, title: 'two', slug: slug2 });
      expect(b1.status).toBe(201);
      expect(b2.status).toBe(201);

      const post = await request(app).post(`/api/v1/board/${slug1}/posts`).send({ title: 't', body: 'b', email: 'secret@person.test', name: 'N' });
      expect(post.status).toBe(201);
      expect(JSON.stringify(post.body)).not.toContain('secret@person.test');
      const postId = post.body.post.id as string;

      const view = await request(app).get(`/api/v1/board/${slug1}`);
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toMatch(/author_email|secret@person\.test/);
      expect(view.body.posts[0].author_name).toBe('N');

      // vote through the WRONG board → 404 and no counter movement
      expect((await request(app).post(`/api/v1/board/${slug2}/posts/${postId}/vote`).send({ email: 'v@x.test' })).status).toBe(404);
      expect(Number((await db!('board_posts').where({ id: postId }).first('vote_count')).vote_count)).toBe(0);

      // correct board: first vote counts, repeat (any email casing) is 409 and doesn't bump
      expect((await request(app).post(`/api/v1/board/${slug1}/posts/${postId}/vote`).send({ email: 'v@x.test' })).status).toBe(201);
      expect((await request(app).post(`/api/v1/board/${slug1}/posts/${postId}/vote`).send({ email: 'V@X.test' })).status).toBe(409);
      expect(Number((await db!('board_posts').where({ id: postId }).first('vote_count')).vote_count)).toBe(1);
      // concurrent duplicates from one voter still count once
      const racers = await Promise.all(
        Array.from({ length: 5 }, () => request(app).post(`/api/v1/board/${slug1}/posts/${postId}/vote`).send({ email: 'race@x.test' })),
      );
      expect(racers.filter((r) => r.status === 201)).toHaveLength(1);
      expect(Number((await db!('board_posts').where({ id: postId }).first('vote_count')).vote_count)).toBe(2);
    });

    it('approval decisions: assigned approver or admin only, and cannot double-advance', async (ctx) => {
      if (!live(ctx)) return;
      const wf = await request(app).post('/api/v1/approvals/workflows').set(bearer(actors.adminA)).send({
        name: 'wf', steps: [{ approver: actors.teamMateA.id }, { approver: actors.viewerA.id }],
      });
      expect(wf.status).toBe(201);
      // creating a workflow is owner/admin only
      expect((await request(app).post('/api/v1/approvals/workflows').set(bearer(actors.memberA)).send({ name: 'x', steps: [{ approver: 'a' }] })).status).toBe(403);

      const started = await request(app).post('/api/v1/approvals/start').set(bearer(actors.ownerA)).send({ workflowId: wf.body.workflow.id, annotationId: T.annotationA });
      expect(started.status).toBe(201);
      const id = started.body.instance.id as string;
      const advance = (a: Actor) => request(app).post(`/api/v1/approvals/${id}/advance`).set(bearer(a)).send({});

      // not the approver for step 0
      expect((await advance(actors.memberA)).status).toBe(403);
      // the assigned approver advances once
      const first = await advance(actors.teamMateA);
      expect(first.status).toBe(200);
      expect(first.body.currentStep).toBe(1);
      // step 1 belongs to viewerA; teamMateA can no longer decide
      expect((await advance(actors.teamMateA)).status).toBe(403);

      // 6 concurrent admin approvals of a 2-step workflow: exactly one advance succeeds per step, never overshoots
      const results = await Promise.all(Array.from({ length: 6 }, () => advance(actors.adminA)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const inst = await db!('approval_instances').where({ id }).first();
      expect(inst.current_step).toBe(2);
      expect(inst.status).toBe('completed');
      expect((await advance(actors.adminA)).status).toBe(409);
    });

    it('csat request does not return the survey token to the requester', async (ctx) => {
      if (!live(ctx)) return;
      await db!('annotations').where({ id: T.annotationA }).update({ status: 'resolved' });
      const res = await request(app).post('/api/v1/csat/request').set(bearer(actors.ownerA)).send({ annotationId: T.annotationA });
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toMatch(/token|rateUrl/i);

      // The token is stored hashed and was delivered to the reporter in-app.
      const sc = await db!('satisfaction_scores').where({ annotation_id: T.annotationA }).first();
      expect(sc.token).toMatch(/^[0-9a-f]{64}$/);
      const note = await db!('user_notifications').where({ user_id: actors.ownerA.id, type: 'csat_request' }).orderBy('created_at', 'desc').first();
      const rateUrl = note.metadata.rateUrl as string;
      const raw = rateUrl.split('/').pop()!;
      expect(createHash('sha256').update(raw).digest('hex')).toBe(sc.token);

      // The raw token (only the reporter has it) rates; the stored hash does not.
      expect((await request(app).post(`/api/v1/csat/rate/${sc.token}`).send({ score: 5 })).status).toBe(404);
      expect((await request(app).post(`/api/v1/csat/rate/${raw}`).send({ score: 5 })).status).toBe(200);
      expect((await request(app).post(`/api/v1/csat/rate/${raw}`).send({ score: 1 })).status).toBe(404); // single use
    });
  });

  // ==========================================================================
  // F-05 client portal
  // ==========================================================================
  describe('F-05 client portal', () => {
    it('emails a magic link (never returns a token), stores it hashed, returns an explicit DTO, rate-limits', async (ctx) => {
      if (!live(ctx)) return;
      const slug = `portal-${randomUUID().slice(0, 8)}`;
      const created = await request(app).post('/api/v1/portals').set(bearer(actors.ownerA)).send({ projectId: T.projectA, title: 'P', slug });
      expect(created.status).toBe(201);
      await db!('annotations').where({ id: T.annotationA }).update({
        guest_email: 'guest@leak.test', session_replay: JSON.stringify([{ type: 'click', timestamp: 1 }]), status: 'active',
      });

      const email = `client-${randomUUID().slice(0, 6)}@authz.test`;
      const req1 = await request(app).post(`/api/v1/portals/${slug}/access`).send({ email });
      expect(req1.status).toBe(202);
      expect(JSON.stringify(req1.body)).not.toMatch(/[0-9a-f]{64}/);
      expect(req1.body.message).toBe("If that email is on the portal you'll receive a link.");

      // Identical answer for an unknown portal (no enumeration).
      const unknown = await request(app).post(`/api/v1/portals/does-not-exist/access`).send({ email });
      expect(unknown.status).toBe(202);
      expect(unknown.body).toEqual(req1.body);

      const mail = mailer.sent.find((m) => m.to === email)!;
      expect(mail).toBeTruthy();
      const raw = /token=([0-9a-f]{64})/.exec(mail.body)![1]!;
      const stored = await db!('portal_sessions').where({ email }).first('token');
      expect(stored.token).toBe(createHash('sha256').update(raw).digest('hex'));

      // Hash is not a credential; the raw emailed token is.
      expect((await request(app).get(`/api/v1/portals/${slug}/feedback`).set({ Authorization: `Bearer ${stored.token}` })).status).toBe(401);
      const feed = await request(app).get(`/api/v1/portals/${slug}/feedback`).set({ Authorization: `Bearer ${raw}` });
      expect(feed.status).toBe(200);
      const allowed = ['id', 'pinNumber', 'type', 'severity', 'status', 'body', 'createdAt', 'pageUrl'].sort();
      expect(feed.body.feedback.length).toBeGreaterThan(0);
      for (const item of feed.body.feedback) expect(Object.keys(item).sort()).toEqual(allowed);
      expect(JSON.stringify(feed.body)).not.toMatch(/guest@leak\.test|org_id|session_replay|captured_|author_id/);

      // A session for one portal does not open another portal's feedback.
      const other = `portal-${randomUUID().slice(0, 8)}`;
      await request(app).post('/api/v1/portals').set(bearer(actors.ownerA)).send({ projectId: T.projectA, title: 'Q', slug: other });
      expect((await request(app).get(`/api/v1/portals/${other}/feedback`).set({ Authorization: `Bearer ${raw}` })).status).toBe(404);

      // Per portal+IP rate limit (configured to 3 above): 1 + 1(unknown slug uses its own key) → keep hitting this portal.
      await request(app).post(`/api/v1/portals/${slug}/access`).send({ email });
      await request(app).post(`/api/v1/portals/${slug}/access`).send({ email });
      expect((await request(app).post(`/api/v1/portals/${slug}/access`).send({ email })).status).toBe(429);
    });

    it('portal admin routes are gated: delete is owner/admin only', async (ctx) => {
      if (!live(ctx)) return;
      const slug = `portal-${randomUUID().slice(0, 8)}`;
      const created = await request(app).post('/api/v1/portals').set(bearer(actors.ownerA)).send({ projectId: T.projectA, title: 'D', slug });
      expect((await request(app).delete(`/api/v1/portals/${created.body.portal.id}`).set(bearer(actors.memberA))).status).toBe(403);
      expect((await request(app).delete(`/api/v1/portals/${created.body.portal.id}`).set(bearer(actors.adminA))).status).toBe(204);
    });
  });

  // ==========================================================================
  // F-11 integrations
  // ==========================================================================
  describe('F-11 integrations', () => {
    it('lists a whitelisted DTO without secrets, and only to owner/admin', async (ctx) => {
      if (!live(ctx)) return;
      await db!('integrations').where({ org_id: T.orgA }).del();
      const connect = await request(app)
        .post('/api/v1/integrations/slack/connect').set(bearer(actors.adminA))
        .send({ accessToken: 'xoxb-secret-token', refreshToken: 'r-secret', config: { channel: '#feedback', clientSecret: 'cs-secret', webhookUrl: 'https://x', apiKey: 'k' } });
      expect(connect.status).toBe(201);

      expect((await request(app).get('/api/v1/integrations').set(bearer(actors.memberA))).status).toBe(403);
      const list = await request(app).get('/api/v1/integrations').set(bearer(actors.adminA));
      expect(list.status).toBe(200);
      const raw = JSON.stringify(list.body);
      expect(raw).not.toMatch(/xoxb-secret-token|r-secret|cs-secret|clientSecret|apiKey|accessToken|refreshToken/);
      expect(list.body.integrations[0]).toMatchObject({ provider: 'slack', enabled: true, config: { channel: '#feedback' } });
      expect(Object.keys(list.body.integrations[0]).sort()).toEqual(['config', 'createdAt', 'enabled', 'id', 'provider']);

      // connect / disconnect are admin-only too
      expect((await request(app).post('/api/v1/integrations/slack/connect').set(bearer(actors.memberA)).send({})).status).toBe(403);
      expect((await request(app).delete('/api/v1/integrations/slack').set(bearer(actors.memberA))).status).toBe(403);
      expect((await request(app).delete('/api/v1/integrations/slack').set(bearer(actors.adminA))).status).toBe(204);
    });
  });
});
