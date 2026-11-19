import type { Knex } from 'knex';

/** PP-06 — e-mail changes are applied only after confirmation at the new address. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('pending_email', 320).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('pending_email');
  });
}
