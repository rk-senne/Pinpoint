import type { Knex } from 'knex';

/**
 * PP-20 — public board votes were deduplicated only by a self-declared (and
 * unverified) e-mail address, so a single client could stuff votes with fake
 * addresses. `voter_key` stores a keyed hash of the caller's IP address
 * (`ip:<hmac>`; the raw address is never stored) and is unique per post, so one
 * network identity gets one vote per post regardless of the e-mail it types.
 * Legacy rows keep `voter_key` NULL (partial unique index).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('board_votes', (t) => {
    t.string('voter_key', 80).nullable();
  });
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS board_votes_post_voter_key_uq ON board_votes (post_id, voter_key) WHERE voter_key IS NOT NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS board_votes_post_voter_key_uq');
  await knex.schema.alterTable('board_votes', (t) => {
    t.dropColumn('voter_key');
  });
}
