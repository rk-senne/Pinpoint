import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('approval_workflows', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.uuid('project_id');
    t.string('name').notNullable();
    t.jsonb('steps').notNullable(); // [{role: 'designer', action: 'annotate'}, {role: 'developer', action: 'implement'}, {role: 'designer', action: 'verify'}]
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('approval_instances', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('workflow_id').notNullable().references('id').inTable('approval_workflows').onDelete('CASCADE');
    t.uuid('annotation_id').notNullable();
    t.integer('current_step').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('in_progress'); // in_progress, completed, rejected
    t.jsonb('step_history').defaultTo('[]'); // [{step, userId, action, completedAt}]
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('approval_instances');
  await knex.schema.dropTableIfExists('approval_workflows');
}
