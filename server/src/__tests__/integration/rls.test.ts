// Integration test (real Postgres): PostgreSQL Row-Level Security (PP-08).
//
// Every assertion runs through the UNPRIVILEGED `pinpoint_app` role (the one
// the API uses in production) with the AsyncLocalStorage tenant context
// installed on its knex pool. Seeding goes through the owner connection
// (DB_USER, superuser/owner → bypasses RLS). Skips gracefully when Postgres or
// the `pinpoint_app` role is unreachable (same convention as the other
// integration tests).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installTenantContext, runAsOrg, runAsSystem } from '../../infrastructure/tenantContext.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');

let owner: Knex | null = null;
let app: Knex | null = null;
let skipReason: string | null = null;

const base = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'pinpoint_test',
};

const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const projA = randomUUID();
const projB = randomUUID();
const pageA = randomUUID();
const pageB = randomUUID();
const annA = randomUUID();
const annB = randomUUID();
const teamA = randomUUID();
const teamB = randomUUID();
const linkA = `rls-${randomUUID()}`;
const linkB = `rls-${randomUUID()}`;

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
      migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
    });
    await owner.raw('SELECT 1');
    await owner.migrate.latest();
    app = installTenantContext(
      knex({
        client: 'pg',
        connection: {
          ...base,
          user: process.env.DB_APP_USER || 'pinpoint_app',
          password: process.env.DB_APP_PASSWORD || 'pinpoint-app-local',
        },
        // Tiny pool on purpose: concurrent contexts MUST share connections.
        pool: { min: 1, max: 2 },
      }),
    );
    await app.raw('SELECT 1');
  } catch (e) {
    skipReason = e instanceof Error ? e.message : String(e);
    await owner?.destroy().catch(() => {});
    await app?.destroy().catch(() => {});
    owner = null;
    app = null;
    return;
  }

  await owner('organizations').insert([
    { id: orgA, name: 'RLS A', slug: `rls-a-${orgA.slice(0, 8)}` },
    { id: orgB, name: 'RLS B', slug: `rls-b-${orgB.slice(0, 8)}` },
  ]);
  await owner('users').insert([
    { id: userA, email: `rls-a-${userA}@example.test`, name: 'A', password_hash: 'x' },
    { id: userB, email: `rls-b-${userB}@example.test`, name: 'B', password_hash: 'x' },
  ]);
  await owner('memberships').insert([
    { org_id: orgA, user_id: userA, role: 'owner' },
    { org_id: orgB, user_id: userB, role: 'owner' },
  ]);
  await owner('projects').insert([
    { id: projA, name: 'PA', urls: [], owner_id: userA, org_id: orgA },
    { id: projB, name: 'PB', urls: [], owner_id: userB, org_id: orgB },
  ]);
  await owner('pages').insert([
    { id: pageA, project_id: projA, url: 'https://a.example.test' },
    { id: pageB, project_id: projB, url: 'https://b.example.test' },
  ]);
  await owner('annotations').insert([
    { id: annA, project_id: projA, org_id: orgA, author_id: userA, type: 'note', body: 'a', target: {}, pin_number: 1, page_id: pageA },
    { id: annB, project_id: projB, org_id: orgB, author_id: userB, type: 'note', body: 'b', target: {}, pin_number: 1, page_id: pageB },
  ]);
  await owner('comments').insert([
    { annotation_id: annA, author_id: userA, body: 'ca', org_id: orgA },
    { annotation_id: annB, author_id: userB, body: 'cb', org_id: orgB },
  ]);
  await owner('teams').insert([
    { id: teamA, name: 'TA', owner_id: userA, org_id: orgA },
    { id: teamB, name: 'TB', owner_id: userB, org_id: orgB },
  ]);
  await owner('team_members').insert([
    { team_id: teamA, user_id: userA, role: 'owner' },
    { team_id: teamB, user_id: userB, role: 'owner' },
  ]);
  await owner('shared_links').insert([
    { id: linkA, project_id: projA },
    { id: linkB, project_id: projB },
  ]);
});

afterAll(async () => {
  if (owner) {
    // Deleting the orgs cascades through projects/annotations/...; users last.
    await owner('shared_links').whereIn('id', [linkA, linkB]).del().catch(() => {});
    await owner('team_members').whereIn('team_id', [teamA, teamB]).del().catch(() => {});
    await owner('comments').whereIn('annotation_id', [annA, annB]).del().catch(() => {});
    await owner('annotations').whereIn('id', [annA, annB]).del().catch(() => {});
    await owner('teams').whereIn('id', [teamA, teamB]).del().catch(() => {});
    await owner('pages').whereIn('id', [pageA, pageB]).del().catch(() => {});
    await owner('projects').whereIn('id', [projA, projB]).del().catch(() => {});
    await owner('memberships').whereIn('org_id', [orgA, orgB]).del().catch(() => {});
    await owner('users').whereIn('id', [userA, userB]).del().catch(() => {});
    await owner('organizations').whereIn('id', [orgA, orgB]).del().catch(() => {});
    await owner.destroy();
  }
  if (app) await app.destroy();
});

function guard(): boolean {
  if (skipReason || !app || !owner) {
    console.warn(`[rls.test] skipped: ${skipReason}`);
    return false;
  }
  return true;
}

const ids = (rows: Array<{ id?: string }>): string[] => rows.map((r) => String(r.id));

describe('PostgreSQL RLS (pinpoint_app role)', () => {
  it('connects as an unprivileged role', async () => {
    if (!guard()) return;
    const { rows } = await app!.raw(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('direct org_id tables: org A sees only its own rows', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      expect(ids(await app!('projects').whereIn('id', [projA, projB]).select('id'))).toEqual([projA]);
      expect(ids(await app!('annotations').whereIn('id', [annA, annB]).select('id'))).toEqual([annA]);
      expect(await app!('comments').whereIn('annotation_id', [annA, annB]).pluck('org_id')).toEqual([orgA]);
      expect(ids(await app!('teams').whereIn('id', [teamA, teamB]).select('id'))).toEqual([teamA]);
      expect(await app!('memberships').whereIn('org_id', [orgA, orgB]).pluck('org_id')).toEqual([orgA]);
    });
    await runAsOrg(orgB, async () => {
      expect(ids(await app!('projects').whereIn('id', [projA, projB]).select('id'))).toEqual([projB]);
    });
  });

  it('organizations: a tenant sees only its own org row', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      expect(ids(await app!('organizations').whereIn('id', [orgA, orgB]).select('id'))).toEqual([orgA]);
    });
  });

  it('parent-scoped tables (EXISTS on parent) hide the other org', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      expect(ids(await app!('pages').whereIn('id', [pageA, pageB]).select('id'))).toEqual([pageA]);
      expect(ids(await app!('shared_links').whereIn('id', [linkA, linkB]).select('id'))).toEqual([linkA]);
      expect(await app!('team_members').whereIn('team_id', [teamA, teamB]).pluck('team_id')).toEqual([teamA]);
    });
  });

  it('WITH CHECK rejects inserting a row for a foreign org', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      await expect(
        app!('projects').insert({ name: 'evil', urls: [], owner_id: userA, org_id: orgB }),
      ).rejects.toThrow(/row-level security/i);
      // child table: page under org B's project
      await expect(
        app!('pages').insert({ project_id: projB, url: 'https://evil.example.test' }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('cannot update or delete another org\u2019s rows (0 affected)', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      expect(await app!('projects').where({ id: projB }).update({ name: 'pwned' })).toBe(0);
      expect(await app!('projects').where({ id: projB }).del()).toBe(0);
    });
    const row = await owner!('projects').where({ id: projB }).first('name');
    expect(row?.name).toBe('PB');
  });

  it('no context ⇒ zero rows and no inserts (fail closed)', async () => {
    if (!guard()) return;
    expect(await app!('projects').whereIn('id', [projA, projB])).toHaveLength(0);
    expect(await app!('pages').whereIn('id', [pageA, pageB])).toHaveLength(0);
    await expect(
      app!('projects').insert({ name: 'x', urls: [], owner_id: userA, org_id: orgA }),
    ).rejects.toThrow(/row-level security/i);
    await runAsOrg(null, async () => {
      expect(await app!('projects').whereIn('id', [projA, projB])).toHaveLength(0);
    });
  });

  it('system context sees every org', async () => {
    if (!guard()) return;
    await runAsSystem(async () => {
      expect(ids(await app!('projects').whereIn('id', [projA, projB]).select('id')).sort()).toEqual(
        [projA, projB].sort(),
      );
      expect(await app!('shared_links').whereIn('id', [linkA, linkB])).toHaveLength(2);
    });
  });

  it('a transaction keeps its context for every statement', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      await app!.transaction(async (trx) => {
        const first = await trx('projects').whereIn('id', [projA, projB]).pluck('id');
        const second = await trx('annotations').whereIn('id', [annA, annB]).pluck('id');
        expect(first).toEqual([projA]);
        expect(second).toEqual([annA]);
        const { rows } = await trx.raw("select current_setting('app.current_org_id', true) as o");
        expect(rows[0].o).toBe(orgA);
      });
    });
  });

  it('concurrent contexts sharing a tiny pool never leak into each other', async () => {
    if (!guard()) return;
    const work = (org: string, own: string, other: string) =>
      runAsOrg(org, async () => {
        for (let i = 0; i < 25; i++) {
          const got = await app!('projects').whereIn('id', [projA, projB]).pluck('id');
          expect(got).toEqual([own]);
          expect(got).not.toContain(other);
          await new Promise((r) => setImmediate(r));
        }
      });
    const sys = runAsSystem(async () => {
      for (let i = 0; i < 25; i++) {
        expect(await app!('projects').whereIn('id', [projA, projB])).toHaveLength(2);
      }
    });
    const none = (async () => {
      for (let i = 0; i < 25; i++) {
        expect(await app!('projects').whereIn('id', [projA, projB])).toHaveLength(0);
      }
    })();
    await Promise.all([work(orgA, projA, projB), work(orgB, projB, projA), sys, none]);
  });

  it('a released connection is reset before the next, context-free use', async () => {
    if (!guard()) return;
    await runAsOrg(orgA, async () => {
      await app!('projects').whereIn('id', [projA]).select('id');
    });
    // Pool max=2: this acquires a connection that was just used under org A.
    const { rows } = await app!.raw("select current_setting('app.current_org_id', true) as o, current_setting('app.system', true) as s");
    expect(rows[0]).toEqual({ o: '', s: 'off' });
  });
});
