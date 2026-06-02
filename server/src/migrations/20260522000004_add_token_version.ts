import type { Knex } from 'knex';

/**
 * Add token_version to users table for session revocation.
 * Incrementing this value invalidates all existing JWTs for the user.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.integer('token_version').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('token_version');
  });
}
