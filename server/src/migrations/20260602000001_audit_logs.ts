import type { Knex } from 'knex';

/**
 * Audit log for sensitive actions (member changes, role updates, key operations, etc.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.uuid('actor_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 100).notNullable(); // e.g. 'member.removed', 'api_key.created'
    t.string('resource_type', 50).notNullable(); // e.g. 'member', 'api_key', 'project'
    t.string('resource_id', 255);
    t.jsonb('metadata').defaultTo('{}');
    t.string('ip_address', 45);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('audit_logs', (t) => {
    t.index(['org_id', 'created_at'], 'idx_audit_logs_org_time');
    t.index(['action'], 'idx_audit_logs_action');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
