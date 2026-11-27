// Tenant context for PostgreSQL Row-Level Security (PP-08).
//
// An AsyncLocalStorage store carries `{ orgId, system }` for the current
// logical operation (an HTTP request, a socket event, a worker tick). Every
// time knex acquires a pooled connection we push that context into the
// session via `set_config('app.current_org_id' | 'app.system', …, false)`, so
// the RLS policies (migration 20261125000101_row_level_security) can read it.
//
// Fail closed: with no store (or `{ orgId: null, system: false }`) both GUCs
// are '' / 'off', and every policy evaluates to false — zero rows visible, no
// rows insertable. The `system` flag is a trusted, server-only escape hatch
// for the pre-tenant lookups (login, public-id links, workers); it can only be
// set by server code through `runAsSystem`, never from request input.
//
// Pool hygiene: each raw connection remembers the values last written to it.
// On acquire we re-issue `set_config` only when the wanted context differs,
// and on release we leave the (known) state in place — the next acquirer
// always converges the connection to ITS context before running a query, so a
// pooled connection can never serve a query under another tenant's context.
// A transaction acquires exactly once, so the setting holds for its duration.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Knex } from 'knex';

export interface TenantStore {
  orgId: string | null;
  system: boolean;
}

const als = new AsyncLocalStorage<TenantStore>();

/** Current context (undefined outside any `runWith*` scope → fail closed). */
export function currentTenant(): TenantStore | undefined {
  return als.getStore();
}

/** Run `fn` scoped to a tenant org. */
export function runAsOrg<T>(orgId: string | null, fn: () => T): T {
  return als.run({ orgId, system: false }, fn);
}

/** Run `fn` with the trusted system context (pre-tenant lookups, workers). */
export function runAsSystem<T>(fn: () => T): T {
  return als.run({ orgId: null, system: true }, fn);
}

/**
 * Bind the request-level store (mutable so the auth layer can narrow it once
 * the tenant is known). Used by the Express middleware.
 */
export function runWithStore<T>(store: TenantStore, fn: () => T): T {
  return als.run(store, fn);
}

/**
 * Set the org of the CURRENT scope (auth middleware, after the session /
 * API key is verified). No-op outside a scope. Never grants `system`.
 */
export function setCurrentOrg(orgId: string | null): void {
  const s = als.getStore();
  if (s && !s.system) s.orgId = orgId;
}

interface TrackedConn {
  query: (sql: string, params: unknown[], cb: (err: Error | null) => void) => void;
  __rlsKey?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wanted(): { org: string; system: string; key: string } {
  const s = als.getStore();
  const org = s && !s.system && s.orgId && UUID_RE.test(s.orgId) ? s.orgId : '';
  const system = s?.system ? 'on' : 'off';
  return { org, system, key: `${org}|${system}` };
}

function applyContext(conn: TrackedConn): Promise<void> {
  const w = wanted();
  if (conn.__rlsKey === w.key) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    conn.query(
      "select set_config('app.current_org_id', $1, false), set_config('app.system', $2, false)",
      [w.org, w.system],
      (err) => {
        if (err) {
          // Unknown state: never reuse this connection under a stale key.
          delete conn.__rlsKey;
          reject(err);
          return;
        }
        conn.__rlsKey = w.key;
        resolve();
      },
    );
  });
}

/**
 * Wrap the knex client so every acquired connection carries the current
 * tenant context. Idempotent. Returns the same knex instance.
 */
export function installTenantContext(db: Knex): Knex {
  const client = db.client as unknown as {
    acquireConnection: () => Promise<TrackedConn>;
    releaseConnection: (conn: TrackedConn) => Promise<void>;
    __tenantCtx?: boolean;
  };
  if (client.__tenantCtx) return db;
  client.__tenantCtx = true;
  const acquire = client.acquireConnection.bind(client);
  const release = client.releaseConnection.bind(client);

  client.acquireConnection = async function acquireWithTenant(): Promise<TrackedConn> {
    const conn = await acquire();
    try {
      await applyContext(conn);
    } catch (err) {
      await release(conn).catch(() => undefined);
      throw err;
    }
    return conn;
  };
  // Released connections keep their tracked key; the next acquire reconciles.
  client.releaseConnection = (conn) => release(conn);
  return db;
}

/**
 * Express middleware granting the trusted system context to a PUBLIC,
 * pre-tenant route (login, public-id shared links, widget keys, portal magic
 * links, review proxy). Mount it only on routes that authenticate by a secret
 * they validate themselves; the handler's own org_id predicates still apply.
 */
export function systemScope(_req: unknown, _res: unknown, next: () => void): void {
  runAsSystem(next);
}
