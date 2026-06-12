import type { Knex } from 'knex';

/**
 * Billing scaffolding — subscription events + usage tracking tables.
 * stripe_customer_id, stripe_subscription_id, plan already exist on organizations.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('subscription_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.string('stripe_event_id', 255).notNullable().unique();
    t.string('event_type', 100).notNullable();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamp('processed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('usage_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.integer('annotations_count').notNullable().defaultTo(0);
    t.unique(['org_id', 'period_start']);
  });

  await knex.schema.alterTable('subscription_events', (t) => {
    t.index(['org_id'], 'idx_subscription_events_org');
  });

  await knex.schema.alterTable('usage_records', (t) => {
    t.index(['org_id'], 'idx_usage_records_org');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('usage_records');
  await knex.schema.dropTableIfExists('subscription_events');
}
