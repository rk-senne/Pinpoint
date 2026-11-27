import { describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import {
  currentTenant,
  installTenantContext,
  runAsOrg,
  runAsSystem,
  runWithStore,
  setCurrentOrg,
} from './tenantContext.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** Fake knex client recording every set_config pushed to a (single) connection. */
function fakeDb(): { db: Knex; calls: string[][]; acquire: () => Promise<unknown> } {
  const calls: string[][] = [];
  const conn = {
    query: (_sql: string, params: string[], cb: (e: Error | null) => void) => {
      calls.push(params);
      cb(null);
    },
  };
  const client = {
    acquireConnection: async () => conn,
    releaseConnection: async () => undefined,
  };
  const db = { client } as unknown as Knex;
  installTenantContext(db);
  return { db, calls, acquire: () => client.acquireConnection() };
}

describe('tenantContext', () => {
  it('has no store (fail closed) outside any scope', () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('runAsOrg / runAsSystem scope the store', () => {
    runAsOrg(ORG_A, () => expect(currentTenant()).toEqual({ orgId: ORG_A, system: false }));
    runAsSystem(() => expect(currentTenant()).toEqual({ orgId: null, system: true }));
  });

  it('setCurrentOrg narrows a request scope but never touches the system scope', () => {
    runWithStore({ orgId: null, system: false }, () => {
      setCurrentOrg(ORG_A);
      expect(currentTenant()?.orgId).toBe(ORG_A);
    });
    runAsSystem(() => {
      setCurrentOrg(ORG_A);
      expect(currentTenant()).toEqual({ orgId: null, system: true });
    });
    expect(() => setCurrentOrg(ORG_A)).not.toThrow(); // no scope: no-op
  });

  it('timers created inside runAsSystem keep the system scope (workers)', async () => {
    const seen = await new Promise<boolean | undefined>((resolve) => {
      runAsSystem(() => {
        const h = setInterval(() => {
          clearInterval(h);
          resolve(currentTenant()?.system);
        }, 1);
      });
    });
    expect(seen).toBe(true);
  });

  it('pushes the context on acquire, only when it changes', async () => {
    const { calls, acquire } = fakeDb();
    await runAsOrg(ORG_A, () => acquire());
    await runAsOrg(ORG_A, () => acquire()); // same context: no extra round trip
    expect(calls).toEqual([[ORG_A, 'off']]);
    await runAsOrg(ORG_B, () => acquire());
    await runAsSystem(() => acquire());
    await acquire(); // no scope: reset to the fail-closed context
    expect(calls).toEqual([
      [ORG_A, 'off'],
      [ORG_B, 'off'],
      ['', 'on'],
      ['', 'off'],
    ]);
  });

  it('never forwards a non-uuid org id into the session setting', async () => {
    const { calls, acquire } = fakeDb();
    await runAsOrg("x'; drop table projects; --", () => acquire());
    expect(calls).toEqual([['', 'off']]);
  });

  it('is idempotent', () => {
    const { db } = fakeDb();
    const before = (db.client as { acquireConnection: unknown }).acquireConnection;
    installTenantContext(db);
    expect((db.client as { acquireConnection: unknown }).acquireConnection).toBe(before);
  });
});
