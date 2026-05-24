import type { Knex } from 'knex';

/**
 * Phase 2 / Task 5.3 — repurpose the existing `password_resets` table as the
 * unified single-use auth-token table (`auth_tokens`).
 *
 * Per Design §1, key decision #4 ("Email verification — repurpose
 * `password_resets` as `auth_tokens` with a `kind` column"), and Requirements
 * 1.1 / 20.1, the system needs ONE single-use-token table that can issue
 * tokens for several flows (`verify_email`, `reset_password`, `team_invite`)
 * instead of three separate tables with the same shape (hash, expires_at,
 * used).
 *
 * This migration is intentionally narrow: it only renames the table and adds
 * the discriminator column. Application code that reads/writes the table is
 * migrated to the new name in the email-verification tasks (6.x); until that
 * lands, downstream auth-token tasks may keep both names in sync via a
 * separate migration if needed.
 *
 * Existing rows are all password-reset tokens, so the new column defaults to
 * `'reset_password'` so the rename is non-destructive and preserves the
 * semantics of any in-flight reset tokens at deploy time.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.renameTable('password_resets', 'auth_tokens');

  await knex.schema.alterTable('auth_tokens', (t) => {
    t.text('kind').notNullable().defaultTo('reset_password');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('auth_tokens', (t) => {
    t.dropColumn('kind');
  });

  await knex.schema.renameTable('auth_tokens', 'password_resets');
}
