// Integration test (real Postgres): privacy / data-subject-rights routes.
//
//   GET    /api/v1/privacy/export
//   GET    /api/v1/privacy/org-export
//   DELETE /api/v1/privacy/account
//   DELETE /api/v1/privacy/org
//
// The repo runs on the UNPRIVILEGED `pinpoint_app` role (RLS enforced) with the
// AsyncLocalStorage tenant context installed — exactly as in production. The
// HTTP layer uses the real auth middleware + JWT issuer. Seeding goes through
// the owner connection. Skips gracefully when Postgres is unreachable.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { installTenantContext, runWithStore } from '../../infrastructure/tenantContext.js';
import { orgIdFromVerifiedToken } from '../../middleware/tenantRateLimit.js';
import { JwtTokenIssuer } from '../../adapters/outbound/jwt/JwtTokenIssuer.js';
import { BcryptPasswordHasher } from '../../adapters/outbound/bcrypt/BcryptPasswordHasher.js';
import { PgPrivacyRepo, DELETED_USER_ID } from '../../adapters/outbound/postgres/PgPrivacyRepo.js';
import { LocalFsScreenshotEraser } from '../../adapters/outbound/privacy/ScreenshotErasers.js';
import { LocalFsScreenshotStore } from '../../adapters/outbound/localfs/LocalFsScreenshotStore.js';
import { createAuthMiddleware } from '../../adapters/inbound/http/auth.middleware.js';
import { createTermsAcceptance } from '../../middleware/termsAcceptance.js';
import { TERMS_VERSION } from '../../domain/privacy/termsVersion.js';
import { createPrivacyRoutes } from '../../adapters/inbound/http/privacy.routes.js';
import { EraseAccount } from '../../domain/privacy/usecases/eraseAccount.js';
import { EraseOrg } from '../../domain/privacy/usecases/eraseOrg.js';
import type { ScreenshotEraser } from '../../domain/privacy/ports/ScreenshotEraser.js';

const SECRET = 'privacy-it-secret-privacy-it-secret-1234';
const PASSWORD = 'Correct-Horse-Battery-9!';
const base = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'pinpoint_test',
};

let owner: Knex | null = null;
let appDb: Knex | null = null;
let skipReason: string | null = null;
let app: Express;
let issuer: JwtTokenIssuer;
let hash = '';
let throttleNow = Date.now();

/** Records which keys the use case asked to delete (and can be told to fail). */
const erased: string[] = [];
const recordingEraser: ScreenshotEraser = {
  async deleteScreenshots(keys) {
    erased.push(...keys);
    return { deleted: keys.length, failed: [] };
  },
};

const created = { orgs: [] as string[], users: [] as string[] };
const tmpDirs: string[] = [];

interface Seeded {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

async function tokenFor(userId: string, email: string, orgId: string, role: string): Promise<string> {
  const row = await owner!('users').where({ id: userId }).first('token_version');
  return issuer.sign({ userId, email, orgId, role, tokenVersion: Number(row?.token_version ?? 0) });
}

async function mkOrg(name = `Org ${randomUUID().slice(0, 6)}`): Promise<string> {
  const id = randomUUID();
  created.orgs.push(id);
  await owner!('organizations').insert({ id, name, slug: `p-${id.slice(0, 12)}` });
  return id;
}

async function mkUser(label: string, passwordHash: string | null = hash): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  created.users.push(id);
  const email = `${label}-${id}@privacy.test`;
  await owner!('users').insert({ id, email, name: label, password_hash: passwordHash, verified: true });
  return { id, email };
}

async function join(orgId: string, userId: string, role: string): Promise<void> {
  await owner!('memberships').insert({ org_id: orgId, user_id: userId, role });
}

async function mkContent(orgId: string, ownerId: string, authorId: string, opts: { screenshot?: string } = {}) {
  const projectId = randomUUID();
  const pageId = randomUUID();
  const annId = randomUUID();
  await owner!('projects').insert({ id: projectId, name: `proj-${projectId.slice(0, 6)}`, urls: [], owner_id: ownerId, org_id: orgId });
  await owner!('pages').insert({ id: pageId, project_id: projectId, url: 'https://site.example.test/p' });
  await owner!('annotations').insert({
    id: annId, project_id: projectId, org_id: orgId, author_id: authorId, type: 'note',
    body: `body-${annId}`, target: {}, pin_number: 1, page_id: pageId,
    screenshot_object_key: opts.screenshot ?? null,
  });
  const commentId = randomUUID();
  await owner!('comments').insert({ id: commentId, annotation_id: annId, author_id: authorId, body: `comment-${commentId}`, org_id: orgId });
  return { projectId, pageId, annId, commentId };
}

async function seedOrgWith(role: string, orgId?: string): Promise<Seeded> {
  const o = orgId ?? (await mkOrg());
  const u = await mkUser(role);
  await join(o, u.id, role);
  return { orgId: o, userId: u.id, email: u.email, token: await tokenFor(u.id, u.email, o, role) };
}

function auth(s: Seeded): { Authorization: string } {
  return { Authorization: `Bearer ${s.token}` };
}

beforeAll(async () => {
  if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
    skipReason = 'SKIP_INTEGRATION_TESTS=true';
    return;
  }
  try {
    owner = knex({
      client: 'pg',
      connection: {
        ...base,
        user: process.env.DB_MIGRATION_USER || process.env.DB_USER || 'postgres',
        password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD || 'postgres',
      },
      pool: { min: 1, max: 4 },
    });
    await owner.raw('SELECT 1');
    // The migration under test must have been applied (tombstone + terms columns).
    const tomb = await owner('users').where({ id: DELETED_USER_ID }).first('id');
    if (!tomb) throw new Error('migration 20261127000101_privacy_features not applied');
    appDb = installTenantContext(
      knex({
        client: 'pg',
        connection: {
          ...base,
          user: process.env.DB_APP_USER || 'pinpoint_app',
          password: process.env.DB_APP_PASSWORD || 'pinpoint-app-local',
        },
        pool: { min: 1, max: 4 },
      }),
    );
    await appDb.raw('SELECT 1');
  } catch (e) {
    skipReason = e instanceof Error ? e.message : String(e);
    await owner?.destroy().catch(() => {});
    await appDb?.destroy().catch(() => {});
    owner = null;
    appDb = null;
    return;
  }

  const hasher = new BcryptPasswordHasher(4);
  hash = await hasher.hash(PASSWORD);
  issuer = new JwtTokenIssuer({ secret: SECRET, accessTtl: '1h', graceWindowSeconds: 60 } as never);
  const repo = new PgPrivacyRepo(appDb);
  const deps = { repo, passwordHasher: hasher, screenshotEraser: recordingEraser };
  const resolveOrg = orgIdFromVerifiedToken(issuer);

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => runWithStore({ orgId: resolveOrg(req) ?? null, system: false }, next));
  app.use(
    '/api/v1/privacy',
    createPrivacyRoutes({
      authMiddleware: createAuthMiddleware({ tokenIssuer: issuer, db: appDb }),
      db: appDb,
      repo,
      eraseAccount: new EraseAccount(deps),
      eraseOrg: new EraseOrg(deps),
      cookieInsecure: true,
      now: () => throttleNow,
    }),
  );
});

afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  if (owner) {
    // Org-scoped rows go with the org (FK cascade); stragglers by user.
    await owner('audit_logs').whereIn('actor_id', created.users).del().catch(() => undefined);
    await owner.raw('ALTER TABLE audit_logs DISABLE TRIGGER USER').catch(() => undefined);
    await owner('audit_logs').whereIn('org_id', created.orgs).del().catch(() => undefined);
    await owner('audit_logs').where('action', 'like', 'privacy.%').whereNull('org_id').del().catch(() => undefined);
    await owner.raw('ALTER TABLE audit_logs ENABLE TRIGGER USER').catch(() => undefined);
    await owner('organizations').whereIn('id', created.orgs).del().catch(() => undefined);
    await owner('users').whereIn('id', created.users).del().catch(() => undefined);
  }
  await owner?.destroy();
  await appDb?.destroy();
});

const live = (name: string, fn: () => Promise<void>, timeout = 30_000): void => {
  it(name, async (ctx) => {
    if (skipReason) {
      // skip-reason: no reachable (migrated) Postgres / pinpoint_app role for the integration suite
      ctx.skip();
      return;
    }
    await fn();
  }, timeout);
};

describe('privacy routes (real Postgres, RLS role)', () => {
  live('the repo really runs as the RLS-bound role', async () => {
    const r = await appDb!.raw('select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b');
    expect(r.rows[0].u).toBe('pinpoint_app');
    expect(r.rows[0].b).toBe(false);
  });

  live('every privacy route requires authentication', async () => {
    expect((await request(app).get('/api/v1/privacy/export')).status).toBe(401);
    expect((await request(app).get('/api/v1/privacy/org-export')).status).toBe(401);
    expect((await request(app).delete('/api/v1/privacy/account').send({})).status).toBe(401);
    expect((await request(app).delete('/api/v1/privacy/org').send({})).status).toBe(401);
  });

  // ---------------------------------------------------------------- export
  live('GET /export returns only the caller’s data across orgs, no secrets, and is audited', async () => {
    const orgA = await mkOrg();
    const orgB = await mkOrg();
    const other = await seedOrgWith('member', orgA);
    const me = await seedOrgWith('owner', orgA);
    await join(orgB, me.userId, 'member');
    const mineA = await mkContent(orgA, me.userId, me.userId, { screenshot: 'annotations/screenshots/x/a.png' });
    const mineB = await mkContent(orgB, me.userId, me.userId);
    const theirs = await mkContent(orgA, other.userId, other.userId);
    // A queued e-mail containing a one-time link: must not leak the link.
    await owner!('notifications').insert({
      payload: JSON.stringify({ kind: 'verify_email', recipientUserId: me.userId, recipientEmail: me.email, link: 'https://x.test/secret-link-token' }),
    });

    const res = await request(app).get('/api/v1/privacy/export').set(auth(me));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="pinpoint-my-data-/);
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = JSON.parse(res.text);
    expect(doc.truncated).toBe(false);
    expect(doc.meta).toMatchObject({ kind: 'user-export', userId: me.userId });
    expect(doc.profile.email).toBe(me.email);
    expect(doc.memberships.map((m: { org_id: string }) => m.org_id).sort()).toEqual([orgA, orgB].sort());
    const annIds = doc.annotations.map((a: { id: string }) => a.id);
    expect(annIds.sort()).toEqual([mineA.annId, mineB.annId].sort());
    expect(annIds).not.toContain(theirs.annId);
    const a = doc.annotations.find((x: { id: string }) => x.id === mineA.annId);
    expect(a.hasScreenshot).toBe(true);
    expect(a.screenshotLink).toBe(`/api/v1/annotations/${mineA.annId}/screenshot`);
    expect(a).not.toHaveProperty('screenshot_object_key');
    expect(doc.comments.map((c: { id: string }) => c.id).sort()).toEqual([mineA.commentId, mineB.commentId].sort());
    expect(doc.queuedEmails).toHaveLength(1);
    // No credentials / one-time secrets anywhere in the document.
    expect(res.text).not.toContain(hash);
    expect(res.text).not.toContain('password_hash');
    expect(res.text).not.toContain('secret-link-token');
    expect(res.text).not.toContain(other.email);

    const audit = await owner!('audit_logs').where({ actor_id: me.userId, action: 'privacy.user_export' });
    expect(audit).toHaveLength(1);
    expect(audit[0].org_id).toBe(orgA);
  });

  live('GET /export flags truncation when the size cap is hit', async () => {
    const o = await mkOrg();
    const me = await seedOrgWith('owner', o);
    for (let i = 0; i < 5; i += 1) await mkContent(o, me.userId, me.userId);
    const tiny = express();
    tiny.use(express.json());
    tiny.use(cookieParser());
    const repo = new PgPrivacyRepo(appDb!);
    const hasher = new BcryptPasswordHasher(4);
    const deps = { repo, passwordHasher: hasher, screenshotEraser: recordingEraser };
    tiny.use((req, _res, next) => runWithStore({ orgId: orgIdFromVerifiedToken(issuer)(req) ?? null, system: false }, next));
    tiny.use(
      '/p',
      createPrivacyRoutes({
        authMiddleware: createAuthMiddleware({ tokenIssuer: issuer, db: appDb! }),
        db: appDb!, repo, eraseAccount: new EraseAccount(deps), eraseOrg: new EraseOrg(deps),
        userExportMaxBytes: 2500,
      }),
    );
    const res = await request(tiny).get('/p/export').set(auth(me));
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.text);
    expect(doc.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(2500);
    expect(doc.annotations.length).toBeLessThan(5);
  });

  live('GET /org-export is owner/admin only and never crosses tenants', async () => {
    const orgA = await mkOrg('Alpha Org');
    const orgB = await mkOrg('Beta Org');
    const adminA = await seedOrgWith('admin', orgA);
    const memberA = await seedOrgWith('member', orgA);
    const viewerA = await seedOrgWith('viewer', orgA);
    const ownerB = await seedOrgWith('owner', orgB);
    const a = await mkContent(orgA, adminA.userId, memberA.userId);
    const b = await mkContent(orgB, ownerB.userId, ownerB.userId);

    expect((await request(app).get('/api/v1/privacy/org-export').set(auth(memberA))).status).toBe(403);
    expect((await request(app).get('/api/v1/privacy/org-export').set(auth(viewerA))).status).toBe(403);

    const res = await request(app).get('/api/v1/privacy/org-export').set(auth(adminA));
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.text);
    expect(doc.meta).toMatchObject({ kind: 'org-export', orgId: orgA });
    expect(doc.organization.name).toBe('Alpha Org');
    expect(doc.annotations.map((x: { id: string }) => x.id)).toEqual([a.annId]);
    expect(doc.comments.map((x: { id: string }) => x.id)).toEqual([a.commentId]);
    expect(doc.projects.map((x: { id: string }) => x.id)).toEqual([a.projectId]);
    expect(doc.pages.map((x: { id: string }) => x.id)).toEqual([a.pageId]);
    expect(res.text).not.toContain(b.annId);
    expect(res.text).not.toContain(ownerB.email);
    expect(res.text).not.toContain('password_hash');
    expect(res.text).not.toContain('stripe_');

    const audit = await owner!('audit_logs').where({ org_id: orgA, action: 'privacy.org_export' });
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(adminA.userId);
  });

  // --------------------------------------------------------- account erasure
  live('DELETE /account rejects a wrong password and keeps everything', async () => {
    const me = await seedOrgWith('owner');
    const res = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: 'nope-nope-nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    expect(await owner!('users').where({ id: me.userId }).first('id')).toBeTruthy();
    const noPw = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({});
    expect(noPw.status).toBe(403);
  });

  live('DELETE /account is refused for the sole owner of an org that has other members', async () => {
    const o = await mkOrg('Shared Org');
    const me = await seedOrgWith('owner', o);
    await seedOrgWith('member', o);
    const res = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOLE_OWNER');
    expect(JSON.stringify(res.body)).toContain('Shared Org');
    expect(await owner!('users').where({ id: me.userId }).first('id')).toBeTruthy();
  });

  live('DELETE /account is refused while a sole-member org has an active subscription', async () => {
    const me = await seedOrgWith('owner');
    await owner!('organizations').where({ id: me.orgId }).update({ stripe_subscription_id: 'sub_test', plan_status: 'active' });
    const res = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTIVE_SUBSCRIPTION');
    expect(await owner!('users').where({ id: me.userId }).first('id')).toBeTruthy();
  });

  live('DELETE /account erases the user, anonymises authored content, scrubs audit PII, deletes sole-member orgs', async () => {
    erased.length = 0;
    const sharedOrg = await mkOrg('Team Org');
    const teammate = await seedOrgWith('owner', sharedOrg);
    const me = await seedOrgWith('member', sharedOrg);
    const personalOrg = await mkOrg('My Personal Org');
    await join(personalOrg, me.userId, 'owner');
    const mine = await mkContent(sharedOrg, me.userId, me.userId, { screenshot: 'annotations/screenshots/s1/keep.png' });
    const personal = await mkContent(personalOrg, me.userId, me.userId, { screenshot: 'annotations/screenshots/s2/gone.png' });
    const tmContent = await mkContent(sharedOrg, teammate.userId, teammate.userId);
    await owner!('comments').where({ id: tmContent.commentId }).update({ mentions: [me.userId, teammate.userId] });
    await owner!('user_notifications').insert({ user_id: me.userId, org_id: sharedOrg, type: 'mention', title: 't', body: 'b' });
    await owner!('notifications').insert({ payload: JSON.stringify({ kind: 'verify_email', recipientUserId: me.userId, recipientEmail: me.email, link: 'x' }) });
    await owner!('audit_logs').insert({ org_id: sharedOrg, actor_id: me.userId, action: 'project.created', resource_type: 'project', ip_address: '203.0.113.9', user_agent: 'UA-test' });
    await owner!('activity_events').insert({ project_id: mine.projectId, actor_id: me.userId, action: 'created', resource_type: 'annotation', resource_id: mine.annId });

    const res = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, orgsDeleted: 1, orgsLeft: 1 });
    expect(String(res.headers['set-cookie'])).toContain('fl_session=;');

    // Identity is gone.
    expect(await owner!('users').where({ id: me.userId }).first('id')).toBeUndefined();
    expect(await owner!('memberships').where({ user_id: me.userId })).toHaveLength(0);
    expect(await owner!('user_notifications').where({ user_id: me.userId })).toHaveLength(0);
    expect(await owner!('notifications').whereRaw("payload->>'recipientUserId' = ?", [me.userId])).toHaveLength(0);
    // The session is dead.
    expect((await request(app).get('/api/v1/privacy/export').set(auth(me))).status).toBe(401);

    // Content in the org that remains is retained, attributed to the tombstone, and re-owned.
    const ann = await owner!('annotations').where({ id: mine.annId }).first();
    expect(ann.author_id).toBe(DELETED_USER_ID);
    expect(ann.body).toBe(`body-${mine.annId}`);
    const com = await owner!('comments').where({ id: mine.commentId }).first();
    expect(com.author_id).toBe(DELETED_USER_ID);
    expect((await owner!('projects').where({ id: mine.projectId }).first()).owner_id).toBe(teammate.userId);
    expect((await owner!('comments').where({ id: tmContent.commentId }).first()).mentions).toEqual([teammate.userId]);
    expect((await owner!('activity_events').where({ project_id: mine.projectId }).first()).actor_id).toBe(DELETED_USER_ID);
    // The teammate's own content is untouched.
    expect((await owner!('annotations').where({ id: tmContent.annId }).first()).author_id).toBe(teammate.userId);

    // The personal (sole-member) org is deleted with its data and screenshot.
    expect(await owner!('organizations').where({ id: personalOrg }).first('id')).toBeUndefined();
    expect(await owner!('annotations').where({ id: personal.annId }).first('id')).toBeUndefined();
    expect(erased).toEqual(['annotations/screenshots/s2/gone.png']);
    expect(erased).not.toContain('annotations/screenshots/s1/keep.png');

    // Audit event kept, personal data scrubbed; deletion itself logged without PII.
    const kept = await owner!('audit_logs').where({ org_id: sharedOrg, action: 'project.created', resource_id: null });
    const scrubbed = kept.find((r) => r.ip_address === null && r.user_agent === null && r.actor_id === null);
    expect(scrubbed).toBeTruthy();
    expect(await owner!('audit_logs').where({ ip_address: '203.0.113.9' })).toHaveLength(0);
    const del = await owner!('audit_logs').where({ action: 'privacy.account_deleted', resource_id: me.userId });
    expect(del).toHaveLength(1);
    expect(del[0].org_id).toBeNull();
    expect(del[0].actor_id).toBeNull();
    expect(JSON.stringify(del[0])).not.toContain(me.email);
    expect(JSON.stringify(del[0])).not.toContain('@');
  });

  live('a user whose e-mail appears on guest/board/portal rows has that data removed too', async () => {
    const o = await mkOrg();
    const teammate = await seedOrgWith('owner', o);
    const me = await seedOrgWith('member', o);
    const c = await mkContent(o, teammate.userId, teammate.userId);
    await owner!('annotations').where({ id: c.annId }).update({ author_id: null, guest_email: me.email.toUpperCase(), guest_name: 'Me', is_guest: true });
    const res = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(res.status).toBe(200);
    const a = await owner!('annotations').where({ id: c.annId }).first();
    expect(a.guest_email).toBeNull();
    expect(a.guest_name).toBe('Deleted user');
  });

  live('re-authentication failures are throttled (429) after 5 attempts', async () => {
    throttleNow = Date.now();
    const me = await seedOrgWith('owner');
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: 'wrong-wrong' });
      expect(r.status).toBe(403);
    }
    const blocked = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(await owner!('users').where({ id: me.userId }).first('id')).toBeTruthy();
    throttleNow += 16 * 60 * 1000; // window passes
    const ok = await request(app).delete('/api/v1/privacy/account').set(auth(me)).send({ password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  // ------------------------------------------------------------ org erasure
  live('DELETE /org: only the owner, with password and the exact org name', async () => {
    const o = await mkOrg('Doomed Org');
    const ownerU = await seedOrgWith('owner', o);
    const admin = await seedOrgWith('admin', o);
    const body = { password: PASSWORD, confirmName: 'Doomed Org' };
    expect((await request(app).delete('/api/v1/privacy/org').set(auth(admin)).send(body)).status).toBe(403);
    const wrongPw = await request(app).delete('/api/v1/privacy/org').set(auth(ownerU)).send({ ...body, password: 'bad-bad-bad' });
    expect(wrongPw.status).toBe(403);
    expect(wrongPw.body.error.code).toBe('INVALID_PASSWORD');
    const wrongName = await request(app).delete('/api/v1/privacy/org').set(auth(ownerU)).send({ ...body, confirmName: 'doomed' });
    expect(wrongName.status).toBe(409);
    expect(wrongName.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await owner!('organizations').where({ id: o }).first('id')).toBeTruthy();

    await owner!('organizations').where({ id: o }).update({ stripe_subscription_id: 'sub_x', plan_status: 'active' });
    const paid = await request(app).delete('/api/v1/privacy/org').set(auth(ownerU)).send(body);
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe('ACTIVE_SUBSCRIPTION');
    expect(await owner!('organizations').where({ id: o }).first('id')).toBeTruthy();
  });

  live('DELETE /org removes the org’s data (and screenshot files) and leaves other tenants untouched', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-privacy-'));
    tmpDirs.push(dir);
    const store = new LocalFsScreenshotStore({ dir, signingSecret: SECRET, publicBaseUrl: 'http://localhost' });
    const key = 'annotations/screenshots/ann1/shot.png';
    const abs = store.resolveKeyPath(key);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'png');
    writeFileSync(`${abs}.markup.json`, '{}');
    const keepKey = 'annotations/screenshots/ann2/other.png';
    const keepAbs = store.resolveKeyPath(keepKey);
    mkdirSync(path.dirname(keepAbs), { recursive: true });
    writeFileSync(keepAbs, 'png');

    const orgA = await mkOrg('Delete Me Inc');
    const orgB = await mkOrg('Keep Me Inc');
    const ownerA = await seedOrgWith('owner', orgA);
    const memberA = await seedOrgWith('member', orgA);
    const ownerB = await seedOrgWith('owner', orgB);
    const a = await mkContent(orgA, ownerA.userId, memberA.userId, { screenshot: key });
    const b = await mkContent(orgB, ownerB.userId, ownerB.userId, { screenshot: keepKey });
    await owner!('client_portals').insert({ org_id: orgA, project_id: a.projectId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'P' });
    await owner!('audit_logs').insert({ org_id: orgA, actor_id: ownerA.userId, action: 'project.created', resource_type: 'project' });

    // Real local-disk eraser through the full route.
    const repo = new PgPrivacyRepo(appDb!);
    const hasher = new BcryptPasswordHasher(4);
    const deps = { repo, passwordHasher: hasher, screenshotEraser: new LocalFsScreenshotEraser(store) };
    const local = express();
    local.use(express.json());
    local.use(cookieParser());
    local.use((req, _res, next) => runWithStore({ orgId: orgIdFromVerifiedToken(issuer)(req) ?? null, system: false }, next));
    local.use(
      '/p',
      createPrivacyRoutes({
        authMiddleware: createAuthMiddleware({ tokenIssuer: issuer, db: appDb! }),
        db: appDb!, repo, eraseAccount: new EraseAccount(deps), eraseOrg: new EraseOrg(deps),
      }),
    );

    const res = await request(local).delete('/p/org').set(auth(ownerA)).send({ password: PASSWORD, confirmName: 'Delete Me Inc' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, screenshotsDeleted: 1, screenshotsFailed: 0 });

    // Org A is gone with everything under it…
    for (const [t, col, val] of [
      ['organizations', 'id', orgA], ['projects', 'org_id', orgA], ['annotations', 'org_id', orgA],
      ['comments', 'org_id', orgA], ['memberships', 'org_id', orgA], ['client_portals', 'org_id', orgA],
    ] as const) {
      expect(await owner!(t).where(col, val)).toHaveLength(0);
    }
    expect(await owner!('pages').where({ id: a.pageId }).first('id')).toBeUndefined();
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(`${abs}.markup.json`)).toBe(false);
    // …the deletion is recorded without an org or PII…
    const ev = await owner!('audit_logs').where({ action: 'privacy.org_deleted', resource_id: orgA });
    expect(ev).toHaveLength(1);
    expect(ev[0].org_id).toBeNull();
    expect(JSON.stringify(ev[0])).not.toContain('Delete Me Inc');
    // …user accounts survive (they just have no membership here any more)…
    expect(await owner!('users').where({ id: memberA.userId }).first('id')).toBeTruthy();
    // …and the other tenant is completely untouched.
    expect(await owner!('annotations').where({ id: b.annId }).first('id')).toBeTruthy();
    expect(await owner!('memberships').where({ org_id: orgB })).toHaveLength(1);
    expect(existsSync(keepAbs)).toBe(true);
    // The old session no longer works for the deleted org.
    expect((await request(local).get('/p/org-export').set(auth(ownerA))).status).toBe(401);
  });

  live('a token for org A cannot erase or export org B (tenant context comes from the token)', async () => {
    const orgA = await mkOrg('Tenant A');
    const orgB = await mkOrg('Tenant B');
    const ownerA = await seedOrgWith('owner', orgA);
    const ownerB = await seedOrgWith('owner', orgB);
    const res = await request(app).delete('/api/v1/privacy/org').set(auth(ownerA)).send({ password: PASSWORD, confirmName: 'Tenant B' });
    expect(res.status).toBe(409); // name of org A is "Tenant A": B is not addressable
    expect(await owner!('organizations').where({ id: orgB }).first('id')).toBeTruthy();
    const exp = await request(app).get('/api/v1/privacy/org-export').set(auth(ownerA));
    expect(JSON.parse(exp.text).organization.id).toBe(orgA);
    expect(exp.text).not.toContain(ownerB.userId);
  });

  live('registration stamps accepted_terms_at (real PG) and refuses without acceptTerms', async () => {
    const reg = express();
    reg.use(express.json());
    reg.use('/auth', createTermsAcceptance({ db: appDb! }));
    // Stand-in for the register use case: inserts the user, answers 201 like the real route.
    reg.post('/auth/register', async (req, res) => {
      const id = randomUUID();
      created.users.push(id);
      await owner!('users').insert({ id, email: `${req.body.name}-${id}@privacy.test`, name: req.body.name, password_hash: 'x', verified: false });
      res.status(201).json({ user: { id } });
    });
    const refused = await request(reg).post('/auth/register').send({ name: 'noterms' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('TERMS_NOT_ACCEPTED');
    expect((await request(reg).post('/auth/register').send({ name: 'falsey', acceptTerms: 'yes' })).status).toBe(400);

    const ok = await request(reg).post('/auth/register').send({ name: 'agreed', acceptTerms: true });
    expect(ok.status).toBe(201);
    const row = await owner!('users').where({ id: ok.body.user.id }).first('accepted_terms_at', 'terms_version');
    expect(row.terms_version).toBe(TERMS_VERSION);
    expect(Date.now() - new Date(row.accepted_terms_at).getTime()).toBeLessThan(60_000);
  });

  live('audit_logs stays append-only: only the PII scrub UPDATE is allowed', async () => {
    const o = await mkOrg();
    const u = await seedOrgWith('owner', o);
    const id = randomUUID();
    await owner!('audit_logs').insert({ id, org_id: o, actor_id: u.userId, action: 'x.y', resource_type: 'x', ip_address: '198.51.100.1' });
    await expect(owner!('audit_logs').where({ id }).update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(owner!('audit_logs').where({ id }).update({ actor_id: null })).rejects.toThrow(/append-only/);
    await expect(owner!('audit_logs').where({ id }).del()).rejects.toThrow(/append-only/);
    await owner!('audit_logs').where({ id }).update({ actor_id: null, ip_address: null, user_agent: null });
    const row = await owner!('audit_logs').where({ id }).first();
    expect(row.action).toBe('x.y');
    expect(row.ip_address).toBeNull();
  });
});
