// Feature: pinpoint-app, Property 12: Pin number uniqueness under concurrency
// **Validates: Requirements 24.1, 24.2**
//
// For any sequence of N concurrent pin-allocation operations against a
// single Project, when each operation completes successfully, all returned
// `pinNumber` values shall be pairwise distinct (Req 24.2). The atomic
// counter implementation
// (`UPDATE projects SET pin_counter = pin_counter + 1 WHERE id = $1
// RETURNING pin_counter` inside a transaction — Req 24.1) is the only
// load-bearing piece for this property.
//
// Rewired: the previous version mounted the legacy `projectAnnotationsRouter`
// over an Express app and fired 32 concurrent HTTP requests. The hex
// equivalent of that surface is the `PgProjectPinSequence` adapter, so
// this test now drives `PgProjectPinSequence.next` directly inside 32
// concurrent Knex transactions. That keeps the property under test
// — pin-counter atomicity — while removing the layers above it (router,
// auth middleware, page upsert) which are exercised by other tests.
//
// Strategy: seed a fresh project with `pin_counter = 0`, then fire 32
// `db.transaction(trx => pinSequence.next(projectId, trx))` calls
// concurrently via `Promise.all` and assert:
//
//   1. Every transaction succeeds.
//   2. All returned pin numbers are pairwise distinct (Req 24.2).
//   3. They form the contiguous set `{1, 2, …, 32}` because the atomic
//      counter starts at 0 and increments by exactly one per commit.
//   4. The project's `pin_counter` column equals 32 afterward (Req 24.1).
//
// Skips gracefully when no Postgres test DB is available.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knex, { Knex } from 'knex';
import crypto from 'crypto';
import path from 'path';

import { PgProjectPinSequence } from '../../adapters/outbound/postgres/PgProjectPinSequence.js';

// Resolve the migrations directory relative to the server workspace so
// the test runs identically whether invoked from the repo root or the
// `server/` workspace.
const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const migrationsDir = path.join(SERVER_ROOT, 'src', 'migrations');

function buildKnexConfig(): Knex.Config {
  return {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 1, max: 8 },
    migrations: {
      directory: migrationsDir,
      extension: 'ts',
    },
  };
}

let dbAvailable = false;
let db: Knex | null = null;
let setupError: string | null = null;
const seededProjectIds: string[] = [];
const seededUserIds: string[] = [];

describe('Property 12: Pin number uniqueness under concurrency (Requirements 24.1, 24.2)', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
      setupError = 'SKIP_INTEGRATION_TESTS=true';
      return;
    }
    try {
      db = knex(buildKnexConfig());
      await db.raw('SELECT 1');
      await db.migrate.latest();
      dbAvailable = true;
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
      if (db) {
        await db.destroy().catch(() => {});
        db = null;
      }
      dbAvailable = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      // Cascade FKs clean up child rows when we delete the project; the
      // user delete sweeps remaining ownership.
      if (seededProjectIds.length > 0) {
        await db('projects').whereIn('id', seededProjectIds).del();
      }
      if (seededUserIds.length > 0) {
        await db('users').whereIn('id', seededUserIds).del();
      }
    } catch {
      // best-effort cleanup; never fail the suite on teardown
    } finally {
      await db.destroy().catch(() => {});
      db = null;
    }
  });

  it('32 concurrent PgProjectPinSequence.next calls return 32 distinct, contiguous pin numbers', async (ctx) => {
    if (!dbAvailable || !db) {
      ctx.skip(`Postgres test DB unavailable: ${setupError ?? 'unknown'}`);
      return;
    }

    // --- Seed a fresh user + project with pin_counter=0 ---
    const userId = crypto.randomUUID();
    const userEmail = `pin-uniqueness-${userId}@test.local`;
    await db('users').insert({
      id: userId,
      email: userEmail,
      name: 'Pin Uniqueness Test User',
      password_hash: 'placeholder-hash',
    });
    seededUserIds.push(userId);

    const projectId = crypto.randomUUID();
    await db('projects').insert({
      id: projectId,
      name: `pin-uniqueness-${projectId}`,
      urls: ['https://example.com/pin-uniqueness'],
      status: 'active',
      owner_id: userId,
      pin_counter: 0,
    });
    seededProjectIds.push(projectId);

    // --- Fire 32 concurrent transactions, each calling pinSequence.next ---
    const pinSequence = new PgProjectPinSequence(db);
    const N = 32;

    const pinNumbers = await Promise.all(
      Array.from({ length: N }, () =>
        db!.transaction((trx) => pinSequence.next(projectId, trx)),
      ),
    );

    // (1) Every transaction must have succeeded; otherwise the atomic
    //     counter has either deadlocked, errored under load, or
    //     produced a duplicate that violated some other invariant.
    for (const pin of pinNumbers) {
      expect(pin).toEqual(expect.any(Number));
    }

    // (2) Property 12 / Req 24.2: all pin numbers are pairwise distinct.
    expect(new Set(pinNumbers).size).toBe(N);

    // (3) Req 24.1/24.3: the atomic counter starts at 0 and increments by
    //     exactly one per committed transaction, so successful calls
    //     produce the contiguous range 1..N. Verifying contiguity rules
    //     out "duplicate replaced" or "shared counter skipped" failure
    //     modes that a distinct-set assertion alone would miss.
    const sorted = [...pinNumbers].sort((a, b) => a - b);
    const expected = Array.from({ length: N }, (_unused, i) => i + 1);
    expect(sorted).toEqual(expected);

    // (4) Cross-check the database directly: the project's `pin_counter`
    //     equals N now that every transaction committed (Req 24.1).
    const projectAfter = await db!('projects').where({ id: projectId }).first();
    expect(projectAfter?.pin_counter).toBe(N);
  }, 60_000);
});
