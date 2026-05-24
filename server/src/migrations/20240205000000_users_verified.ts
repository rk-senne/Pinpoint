import type { Knex } from 'knex';

/**
 * Adds `verified` boolean to `users` for the email-verification flow (Req 20.1).
 *
 * The default of `true` is intentional: existing accounts predate the verification
 * requirement and must remain logged-in after this migration runs. Application
 * code (task 6.1) is responsible for explicitly setting `verified=false` on
 * newly registered users so they cannot log in until they click the verification
 * link.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('verified').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('verified');
  });
}
