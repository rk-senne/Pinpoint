import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';
import {
  assertProjectAccess,
  AccessDeniedError,
  canAccessProject,
  requireRole,
  requireWriteAccess,
  requireOrgAdmin,
} from './access.js';
import { createAuthMiddleware, createOptionalAuthMiddleware } from './auth.middleware.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';

/** Table-aware Knex stand-in: `projects` and `team_members` lookups. */
function dbWith(opts: { project?: Record<string, unknown>; teamMembers?: string[] }) {
  return vi.fn((table: string) => {
    let filter: Record<string, string> = {};
    const b: Record<string, unknown> = {};
    b.where = (f: Record<string, string>) => {
      filter = f;
      return b;
    };
    b.first = () => {
      if (table === 'projects') {
        const p = opts.project;
        return Promise.resolve(p && p.id === filter.id && p.org_id === filter.org_id ? p : undefined);
      }
      if (table === 'team_members') {
        return Promise.resolve((opts.teamMembers ?? []).includes(`${filter.team_id}:${filter.user_id}`) ? { user_id: filter.user_id } : undefined);
      }
      return Promise.resolve(undefined);
    };
    return b;
  }) as never;
}

describe('assertProjectAccess — same rule as domain/shared/projectAccess.ts + org match', () => {
  const project = { id: PROJECT, org_id: ORG, owner_id: 'owner-1', team_id: 'team-1' };
  const db = dbWith({ project, teamMembers: ['team-1:mate-1'] });

  it('owner and team member pass', async () => {
    await expect(assertProjectAccess(db, { userId: 'owner-1', orgId: ORG }, PROJECT)).resolves.toMatchObject({ id: PROJECT });
    await expect(assertProjectAccess(db, { userId: 'mate-1', orgId: ORG }, PROJECT)).resolves.toMatchObject({ id: PROJECT });
  });

  it('same-org non-member, other-org user, and unknown project all fail identically', async () => {
    await expect(assertProjectAccess(db, { userId: 'rando', orgId: ORG }, PROJECT)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(assertProjectAccess(db, { userId: 'owner-1', orgId: OTHER_ORG }, PROJECT)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(assertProjectAccess(db, { userId: 'owner-1', orgId: ORG }, 'missing')).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(assertProjectAccess(db, { userId: 'owner-1', orgId: ORG }, undefined)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('a project without a team grants access only to its owner', async () => {
    const solo = dbWith({ project: { id: PROJECT, org_id: ORG, owner_id: 'owner-1', team_id: null } });
    expect(await canAccessProject(solo, { userId: 'owner-1', orgId: ORG }, PROJECT)).toBe(true);
    expect(await canAccessProject(solo, { userId: 'mate-1', orgId: ORG }, PROJECT)).toBe(false);
  });
});

describe('requireRole / requireOrgAdmin / requireWriteAccess', () => {
  const appFor = (role: string | undefined) => {
    const app = express();
    app.use((req, _res, next) => {
      if (role) (req as any).user = { userId: 'u', email: 'e', orgId: ORG, role };
      next();
    });
    app.get('/owner-only', requireRole('owner'), (_q, r) => r.json({ ok: true }));
    app.get('/admin', requireOrgAdmin, (_q, r) => r.json({ ok: true }));
    app.post('/write', requireWriteAccess, (_q, r) => r.json({ ok: true }));
    return app;
  };

  it('requireRole allows only listed roles', async () => {
    expect((await request(appFor('owner')).get('/owner-only')).status).toBe(200);
    expect((await request(appFor('admin')).get('/owner-only')).status).toBe(403);
    expect((await request(appFor(undefined)).get('/owner-only')).status).toBe(403);
  });

  it('requireOrgAdmin = owner|admin; API-key principals and plain members are denied', async () => {
    for (const [role, status] of [['owner', 200], ['admin', 200], ['member', 403], ['viewer', 403], ['api_key', 403]] as const) {
      expect((await request(appFor(role)).get('/admin')).status, role).toBe(status);
    }
  });

  it('requireRole never grants an api_key principal, even when listed', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { userId: 'u', email: '', orgId: ORG, role: 'api_key' };
      next();
    });
    app.get('/x', requireRole('api_key', 'owner'), (_q, r) => r.json({ ok: true }));
    expect((await request(app).get('/x')).status).toBe(403);
  });

  it('requireWriteAccess blocks viewers only', async () => {
    expect((await request(appFor('viewer')).post('/write')).status).toBe(403);
    for (const role of ['member', 'admin', 'owner', 'api_key']) {
      expect((await request(appFor(role)).post('/write')).status, role).toBe(200);
    }
  });
});

describe('createAuthMiddleware — session validation', () => {
  const claims = { userId: 'u1', email: 'e@x.test', orgId: ORG, role: 'owner', tokenVersion: 2, exp: 9_999_999_999 };
  const tokenIssuer = { verify: (t: string) => { if (t !== 'good') throw new Error('bad'); return claims; } } as never;
  const sessionDb = (row: Record<string, unknown> | undefined, onQuery?: () => void) =>
    ((_table: string) => {
      const b: Record<string, unknown> = {};
      b.leftJoin = () => b;
      b.where = () => b;
      b.first = () => {
        onQuery?.();
        return Promise.resolve(row);
      };
      return b;
    }) as never;

  const run = async (db: unknown, token = 'good') => {
    const app = express();
    app.use(createAuthMiddleware({ tokenIssuer, db: db as never }));
    app.get('/me', (req, res) => res.json({ user: req.user }));
    return request(app).get('/me').set('Authorization', `Bearer ${token}`);
  };

  it('accepts a current session and exposes the LIVE role + token_version', async () => {
    const res = await run(sessionDb({ token_version: 2, name: 'N', role: 'admin' }));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ userId: 'u1', role: 'admin', tokenVersion: 2 });
  });

  it('rejects a lower token_version, a missing membership, and an unknown user', async () => {
    expect((await run(sessionDb({ token_version: 3, name: 'N', role: 'owner' }))).status).toBe(401);
    expect((await run(sessionDb({ token_version: 2, name: 'N', role: null }))).status).toBe(401);
    expect((await run(sessionDb(undefined))).status).toBe(401);
  });

  it('treats a malformed-uuid DB error (22P02) as an invalid session, other DB errors as 500', async () => {
    const failing = (code: string) =>
      (() => {
        const b: Record<string, unknown> = {};
        b.leftJoin = () => b;
        b.where = () => b;
        b.first = () => Promise.reject(Object.assign(new Error('db'), { code }));
        return b;
      }) as unknown;
    expect((await run(failing('22P02'))).status).toBe(401);
    expect((await run(failing('08006'))).status).toBe(500);
  });

  it('still rejects a bad signature without touching the database', async () => {
    let queried = false;
    const res = await run(sessionDb({ token_version: 2, role: 'owner' }, () => { queried = true; }), 'forged');
    expect(res.status).toBe(401);
    expect(queried).toBe(false);
  });
});

describe('createOptionalAuthMiddleware (used by logout)', () => {
  const claims = { userId: 'u1', email: 'e@x.test', orgId: ORG, role: 'owner', tokenVersion: 0, exp: 9_999_999_999 };
  const tokenIssuer = { verify: (t: string) => { if (t !== 'good') throw new Error('bad'); return claims; } } as never;
  const db = (() => {
    const b: Record<string, unknown> = {};
    b.leftJoin = () => b;
    b.where = () => b;
    b.first = () => Promise.resolve({ token_version: 0, name: 'N', role: 'owner' });
    return b;
  }) as never;
  const app = () => {
    const a = express();
    a.use(createOptionalAuthMiddleware({ tokenIssuer, db }));
    a.post('/logout', (req, res) => res.json({ userId: req.user?.userId ?? null }));
    return a;
  };

  it('populates req.user for a valid session', async () => {
    const res = await request(app()).post('/logout').set('Authorization', 'Bearer good');
    expect(res.body.userId).toBe('u1');
  });

  it('never blocks: no token or a bad token proceed anonymously', async () => {
    expect((await request(app()).post('/logout')).body.userId).toBeNull();
    const bad = await request(app()).post('/logout').set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(200);
    expect(bad.body.userId).toBeNull();
  });
});
