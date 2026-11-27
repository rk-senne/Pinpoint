import type { Knex } from 'knex';

/**
 * TOTP two-factor authentication (RFC 6238).
 *
 * `user_mfa`            one row per user: the SecretBox-encrypted shared secret,
 *                       enabled flag, replay guard (`last_step`) and the
 *                       brute-force counters (`failed_attempts`, `locked_until`).
 * `user_recovery_codes` single-use recovery codes, stored only as SHA-256.
 *
 * RLS: like `users` / `auth_tokens` these tables are identity data that is read
 * BEFORE a tenant is known (login step-up) and carry no org_id, so they are
 * deliberately outside the tenant policies (see migration
 * 20261125000101_row_level_security.ts). Access is only through PgMfaRepo, always
 * keyed by an authenticated or challenge-verified user id. The pinpoint_app role
 * receives its grants from that migration's ALTER DEFAULT PRIVILEGES.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_mfa', (t) => {
    t.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.text('secret_enc').notNullable();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.bigInteger('last_step').nullable();
    t.integer('failed_attempts').notNullable().defaultTo(0);
    t.timestamp('locked_until', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('enabled_at', { useTz: true }).nullable();
  });
  await knex.schema.createTable('user_recovery_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('code_hash', 64).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
    t.unique(['user_id', 'code_hash']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_recovery_codes');
  await knex.schema.dropTableIfExists('user_mfa');
}
