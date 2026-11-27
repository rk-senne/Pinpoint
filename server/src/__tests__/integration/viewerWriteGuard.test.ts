// PP-05 regression (docs/SECURITY_REVIEW.md): table-driven over EVERY mutating
// route actually mounted by the real composition root. A `viewer` must get 403
// on all of them unless the route is explicitly listed as not-viewer-guarded
// (public / self-service). A new mutating route therefore fails this test until
// someone classifies it. GET /webhooks and GET /api-keys are admin-only.
//
// Skips when no Postgres test DB is reachable.

import { randomUUID } from 'node:crypto';
import express from 'express';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { request } from '../supertestClient.js';
import { buildContainer, loadConfigFromEnv, type Container } from '../../composition/container.js';
import { JwtTokenIssuer } from '../../adapters/outbound/jwt/JwtTokenIssuer.js';

/** Mutating routes that are intentionally NOT viewer-guarded (public or self-service). */
const NOT_VIEWER_GUARDED = new Set<string>([
  // public / unauthenticated (own auth: link password, token, widget key, magic link)
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/verify-email/:token',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/shared/:linkId/verify',
  'POST /api/v1/shared/:linkId/feedback',
  'POST /api/v1/board/:slug/posts',
  'POST /api/v1/board/:slug/posts/:postId/vote',
  'POST /api/v1/csat/rate/:token',
  'POST /api/v1/auth/reset-password/:token',
  'POST /api/v1/portals/:slug/access',
  'POST /api/v1/widget/feedback', // widget key, not a session
  // self-service: only touches the caller's own account / session
  'PUT /api/v1/users/me',
  // 2FA is per-account security, never tenant data (viewers must be able to protect their account)
  'POST /api/v1/auth/login/mfa',
  'POST /api/v1/auth/mfa/enroll',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/auth/mfa/disable',
  'POST /api/v1/auth/mfa/recovery-codes',
  'POST /api/v1/auth/mfa/*splat', // rate-limiter mount for the routes above, not a handler
  'DELETE /api/v1/privacy/account', // a viewer may erase their own account
  'PUT /api/v1/users/me/notifications',
  'PUT /api/v1/notifications/preferences',
  'POST /api/v1/notifications/read-all',
  'PATCH /api/v1/notifications/:id/read',
  'POST /api/v1/org/switch',
  'POST /api/v1/org/invitations/accept',
  // an approver decides their own step (identity checked in the use case)
  'POST /api/v1/approvals/:instanceId/advance',
]);

let db: Knex | null = null;
let container: Container | null = null;
let skip: string | null = null;
const orgId = randomUUID();
const viewerId = randomUUID();
const adminId = randomUUID();
let issuerRef: JwtTokenIssuer;
/** Signed against the CURRENT token_version: the sweep itself hits logout / revoke-sessions, which bump it. */
async function tokenFor(id: string, role: string): Promise<string> {
  const row = await db!('users').where({ id }).first('token_version');
  return issuerRef.sign({ userId: id, email: `${role}-${id}@guard.test`, orgId, role, tokenVersion: Number(row?.token_version ?? 0) });
}

interface RouteEntry { method: string; path: string }
const routes: RouteEntry[] = [];

describe('Integration: viewer write guard (PP-05)', () => {
  beforeAll(async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
      NODE_ENV: 'test',
      API_RATE_LIMIT_MAX: '1000000',
      AUTH_RATE_LIMIT_IP_MAX: '1000000',
      TENANT_RATE_LIMIT_MAX: '1000000',
    };
    const probe = knex({
      client: 'pg',
      connection: {
        host: env.DB_HOST ?? 'localhost',
        port: Number(env.DB_PORT ?? 5432),
        database: env.DB_NAME ?? 'pinpoint_test',
        user: env.DB_USER ?? 'postgres',
        password: env.DB_PASSWORD ?? 'postgres',
      },
    });
    try {
      await probe.raw('select 1');
      await probe('organizations').count('* as c');
      db = probe;
    } catch (e) {
      skip = `no test database: ${(e as Error).message}`;
      await probe.destroy().catch(() => undefined);
      return;
    }

    // Record every (mount path, router) the composition root installs.
    const mounts = new Map<unknown, string>();
    const origUse = express.application.use;
    const spy = vi.spyOn(express.application, 'use').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string' && typeof args[1] === 'function') mounts.set(args[1], args[0]);
      return (origUse as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    container = buildContainer(loadConfigFromEnv(env as NodeJS.ProcessEnv));
    spy.mockRestore();

    for (const layer of (container.app as unknown as { router: { stack: any[] } }).router.stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path });
      } else if (layer.handle?.stack && mounts.has(layer.handle)) {
        const prefix = mounts.get(layer.handle)!;
        for (const l of layer.handle.stack) {
          if (!l.route) continue;
          for (const m of Object.keys(l.route.methods)) {
            routes.push({ method: m.toUpperCase(), path: (prefix + (l.route.path === '/' ? '' : l.route.path)) || '/' });
          }
        }
      }
    }

    await db('organizations').insert({ id: orgId, name: 'viewer-guard', slug: `vg-${orgId.slice(0, 8)}` });
    for (const [id, role] of [[viewerId, 'viewer'], [adminId, 'admin']] as const) {
      await db('users').insert({ id, email: `${role}-${id}@guard.test`, name: role, password_hash: 'x', verified: true });
      await db('memberships').insert({ org_id: orgId, user_id: id, role });
    }
    const issuer = new JwtTokenIssuer({ secret: env.JWT_SECRET!, accessTtl: '1h', graceWindowSeconds: 60 } as never);
    issuerRef = issuer;
  });

  afterAll(async () => {
    if (db) {
      await db('memberships').where({ org_id: orgId }).del();
      await db('users').whereIn('id', [viewerId, adminId]).del();
      await db('organizations').where({ id: orgId }).del();
      await db.destroy();
    }
    if (container) await container.db.destroy();
  });

  const concrete = (p: string): string => p.replace(/:[A-Za-z]+/g, () => randomUUID());

  it('enumerates a plausible number of mounted routes', ({ skip: s }) => {
    if (skip) return s(skip);
    expect(routes.filter((r) => r.method !== 'GET').length).toBeGreaterThan(60);
  });

  it('every mutating route answers 403 to a viewer unless classified as not-guarded', async ({ skip: s }) => {
    if (skip) return s(skip);
    const app = container!.app;
    const bad: string[] = [];
    const stale: string[] = [];
    for (const r of routes) {
      if (r.method === 'GET' || r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      if (!r.path.startsWith('/api/v1/')) continue;
      const key = `${r.method} ${r.path}`;
      const res = await (request(app) as any)[r.method.toLowerCase()](concrete(r.path))
        .set('Authorization', `Bearer ${await tokenFor(viewerId, 'viewer')}`)
        .send({});
      const forbidden = res.status === 403 && res.body?.error?.code === 'FORBIDDEN';
      if (NOT_VIEWER_GUARDED.has(key)) {
        if (forbidden) stale.push(key);
      } else if (!forbidden) {
        bad.push(`${key} → ${res.status}`);
      }
    }
    const mounted = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const unknown = [...NOT_VIEWER_GUARDED].filter((k) => !mounted.has(k));
    expect({ bad, stale, unknown }).toEqual({ bad: [], stale: [], unknown: [] });
  });

  it('GET /webhooks and GET /api-keys are owner/admin only', async ({ skip: s }) => {
    if (skip) return s(skip);
    const app = container!.app;
    for (const p of ['/api/v1/webhooks', '/api/v1/api-keys']) {
      expect((await request(app).get(p).set('Authorization', `Bearer ${await tokenFor(viewerId, 'viewer')}`)).status).toBe(403);
      expect((await request(app).get(p).set('Authorization', `Bearer ${await tokenFor(adminId, 'admin')}`)).status).toBe(200);
    }
  });
});
