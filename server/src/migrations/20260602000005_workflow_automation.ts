import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('automation_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.uuid('project_id'); // null = org-wide
    t.string('name').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.string('trigger_event', 50).notNullable(); // 'annotation.created', 'annotation.status_changed'
    t.jsonb('conditions').notNullable().defaultTo('{}'); // { severity: 'critical', type: 'bug' }
    t.string('action_type', 50).notNullable(); // 'assign', 'set_status', 'set_due_date', 'notify'
    t.jsonb('action_params').notNullable(); // { assigneeId: '...' } or { status: 'resolved' }
    t.integer('priority').notNullable().defaultTo(0); // execution order
    t.timestamps(true, true);

    t.index(['org_id', 'trigger_event', 'active'], 'idx_automation_rules_trigger');
  });

  // SLA policies
  await knex.schema.createTable('sla_policies', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.string('name').notNullable();
    t.string('severity', 20).notNullable(); // 'critical', 'major', 'minor'
    t.integer('response_time_hours').notNullable(); // first response SLA
    t.integer('resolution_time_hours').notNullable(); // resolution SLA
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    t.unique(['org_id', 'severity']);
  });

  // Track SLA breaches
  await knex.schema.createTable('sla_breaches', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('annotation_id').notNullable().references('id').inTable('annotations').onDelete('CASCADE');
    t.uuid('sla_policy_id').notNullable().references('id').inTable('sla_policies').onDelete('CASCADE');
    t.string('breach_type', 20).notNullable(); // 'response', 'resolution'
    t.timestamp('breached_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sla_breaches');
  await knex.schema.dropTableIfExists('sla_policies');
  await knex.schema.dropTableIfExists('automation_rules');
}
