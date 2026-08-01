import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('activity_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.uuid('actor_id').notNullable();
    t.string('action', 50).notNullable(); // e.g. 'annotation.created', 'status.changed'
    t.string('resource_type', 30).notNullable(); // 'annotation', 'comment', 'project'
    t.uuid('resource_id').nullable();
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['project_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('activity_events');
}
