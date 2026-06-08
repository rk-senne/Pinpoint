import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('satisfaction_scores', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('annotation_id').notNullable().references('id').inTable('annotations').onDelete('CASCADE');
    t.uuid('org_id').notNullable();
    t.uuid('reporter_id').notNullable(); // original annotation author
    t.uuid('resolver_id'); // who resolved it
    t.integer('score'); // 1-5 or null if not yet rated
    t.text('comment');
    t.string('token', 64).unique(); // one-time rating link
    t.timestamp('requested_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('rated_at');
    t.timestamps(true, true);

    t.unique('annotation_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('satisfaction_scores');
}
