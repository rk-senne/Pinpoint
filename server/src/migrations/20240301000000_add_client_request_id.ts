import type { Knex } from 'knex';

/**
 * Phase 22 / Task 35.1 — offline-replay idempotency columns.
 *
 * Adds `client_request_id UUID NULL` to both `annotations` and `comments`,
 * each backed by a partial UNIQUE index that ignores NULLs. This is the
 * server-side foundation for the Extension's offline-mode outbox: when the
 * Syncer replays a queued operation it attaches the locally-generated UUID
 * as `clientRequestId`, and the create endpoint (Task 35.2) returns the
 * pre-existing row with `X-FL-Idempotent-Replay: true` instead of inserting
 * a duplicate. (Req 44.3, Design §30 and the indexes table.)
 *
 * Why a partial unique index rather than a plain UNIQUE constraint:
 * Postgres treats every NULL as distinct, so a regular UNIQUE on a nullable
 * column already permits many NULL rows. The partial index makes that intent
 * explicit, keeps the index small (only rows that opted into idempotency are
 * indexed), and matches the design doc verbatim
 * (`UNIQUE WHERE client_request_id IS NOT NULL`).
 */
const ANNOTATIONS_INDEX = 'annotations_client_request_id_uniq';
const COMMENTS_INDEX = 'comments_client_request_id_uniq';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('annotations', (t) => {
    t.uuid('client_request_id').nullable();
  });

  await knex.schema.alterTable('comments', (t) => {
    t.uuid('client_request_id').nullable();
  });

  // Partial UNIQUE indexes — Knex's index builder cannot express a partial
  // index, so we drop down to raw SQL.
  await knex.raw(
    `CREATE UNIQUE INDEX ${ANNOTATIONS_INDEX}
       ON annotations (client_request_id)
       WHERE client_request_id IS NOT NULL`
  );

  await knex.raw(
    `CREATE UNIQUE INDEX ${COMMENTS_INDEX}
       ON comments (client_request_id)
       WHERE client_request_id IS NOT NULL`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${ANNOTATIONS_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${COMMENTS_INDEX}`);

  await knex.schema.alterTable('annotations', (t) => {
    t.dropColumn('client_request_id');
  });

  await knex.schema.alterTable('comments', (t) => {
    t.dropColumn('client_request_id');
  });
}
