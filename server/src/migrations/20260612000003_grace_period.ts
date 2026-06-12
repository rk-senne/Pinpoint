import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (t) => {
    t.timestamp('grace_period_ends_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (t) => {
    t.dropColumn('grace_period_ends_at');
  });
}
