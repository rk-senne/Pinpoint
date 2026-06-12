import type { Knex } from 'knex';

/**
 * OAuth accounts linking table + allow NULL password_hash for OAuth-only users.
 */
export async function up(knex: Knex): Promise<void> {
  // Allow OAuth-only users (no password)
  await knex.schema.alterTable('users', (t) => {
    t.string('password_hash', 255).nullable().alter();
  });

  await knex.schema.createTable('oauth_accounts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('provider', 32).notNullable();
    t.string('provider_user_id', 255).notNullable();
    t.string('email', 255);
    t.string('name', 255);
    t.string('avatar_url', 1024);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['provider', 'provider_user_id']);
  });

  await knex.schema.alterTable('oauth_accounts', (t) => {
    t.index(['user_id'], 'idx_oauth_accounts_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('oauth_accounts');

  // Restore NOT NULL — delete any OAuth-only users first
  await knex('users').whereNull('password_hash').del();
  await knex.schema.alterTable('users', (t) => {
    t.string('password_hash', 255).notNullable().alter();
  });
}
