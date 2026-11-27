import type { Knex } from 'knex';

/**
 * Security audit F-05 / F-07 / F-12: bearer tokens that used to be stored in
 * clear text are now stored as SHA-256 hex (64 chars, so every existing
 * column — varchar(255) / varchar(64) — already fits):
 *
 *   - invitations.token         (org invitation links)
 *   - portal_sessions.token     (client-portal magic links / sessions)
 *   - satisfaction_scores.token (CSAT rating links)
 *
 * Existing rows are hashed in place, so outstanding links keep working: the
 * application now hashes the presented raw token before looking it up. A
 * database leak no longer yields redeemable tokens.
 *
 * Not reversible (the raw values are gone by design); `down` is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  // sha256() is built in from PostgreSQL 11; no pgcrypto required.
  for (const table of ['invitations', 'portal_sessions', 'satisfaction_scores']) {
    await knex.raw(
      `UPDATE ?? SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token IS NOT NULL`,
      [table],
    );
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Irreversible by design.
}
