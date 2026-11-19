// Shared harness for integration tests that need the REAL composition root
// (all routers + middleware + real Postgres). Returns null when no test DB is
// reachable so callers can skip gracefully.

import { randomUUID } from 'node:crypto';
import knex, { type Knex } from 'knex';

import { buildContainer, loadConfigFromEnv, type Container } from '../../../composition/container.js';
import { JwtTokenIssuer } from '../../../adapters/outbound/jwt/JwtTokenIssuer.js';

export interface LiveActor {
  id: string;
  email: string;
  role: string;
  orgId: string;
  /** Fresh JWT signed against the CURRENT token_version. */
  token(): Promise<string>;
}

export interface LiveApp {
  container: Container;
  app: Container['app'];
  db: Knex;
  /** Create an org with one actor per role. Registered for cleanup. */
  seedOrg(roles: string[]): Promise<{ orgId: string; actors: Record<string, LiveActor> }>;
  /** Create a project in the org owned by the given user. */
  seedProject(orgId: string, ownerId: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function bootLiveApp(extraEnv: Record<string, string> = {}): Promise<LiveApp | { skip: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
    NODE_ENV: 'test',
    API_RATE_LIMIT_MAX: '1000000',
    AUTH_RATE_LIMIT_IP_MAX: '1000000',
    TENANT_RATE_LIMIT_MAX: '1000000',
    ...extraEnv,
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
    await probe('teams').columns('org_id').limit(0); // migrated through PP-04
  } catch (e) {
    await probe.destroy().catch(() => undefined);
    return { skip: `no (migrated) test database: ${(e as Error).message}` };
  }
  const container = buildContainer(loadConfigFromEnv(env as NodeJS.ProcessEnv));
  const issuer = new JwtTokenIssuer({ secret: env.JWT_SECRET!, accessTtl: '1h', graceWindowSeconds: 60 } as never);
  const orgs: string[] = [];
  const users: string[] = [];

  return {
    container,
    app: container.app,
    db: probe,
    async seedOrg(roles) {
      const orgId = randomUUID();
      orgs.push(orgId);
      await probe('organizations').insert({ id: orgId, name: `it-${orgId.slice(0, 8)}`, slug: `it-${orgId.slice(0, 12)}` });
      const actors: Record<string, LiveActor> = {};
      for (const role of roles) {
        const id = randomUUID();
        users.push(id);
        const email = `${role}-${id}@live.test`;
        await probe('users').insert({ id, email, name: role, password_hash: 'x', verified: true });
        await probe('memberships').insert({ org_id: orgId, user_id: id, role });
        actors[role] = {
          id, email, role, orgId,
          token: async () => {
            const row = await probe('users').where({ id }).first('token_version');
            return issuer.sign({ userId: id, email, orgId, role, tokenVersion: Number(row?.token_version ?? 0) });
          },
        };
      }
      return { orgId, actors };
    },
    async seedProject(orgId, ownerId) {
      const id = randomUUID();
      await probe('projects').insert({ id, name: 'it-project', owner_id: ownerId, org_id: orgId });
      return id;
    },
    async cleanup() {
      // Org-scoped rows without FK (PP-10) are removed explicitly.
      for (const t of ['client_portals', 'automation_rules', 'sla_policies', 'webhook_endpoints', 'feedback_boards', 'api_keys', 'audit_logs']) {
        await probe(t).whereIn('org_id', orgs).del().catch(() => undefined);
      }
      await probe('projects').whereIn('org_id', orgs).del().catch(() => undefined);
      await probe('teams').whereIn('org_id', orgs).del().catch(() => undefined);
      await probe('memberships').whereIn('org_id', orgs).del().catch(() => undefined);
      await probe('users').whereIn('id', users).del().catch(() => undefined);
      await probe('organizations').whereIn('id', orgs).del().catch(() => undefined);
      await probe.destroy();
      await container.db.destroy();
    },
  };
}
