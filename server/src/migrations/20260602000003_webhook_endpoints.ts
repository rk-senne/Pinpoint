import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('webhook_endpoints', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.string('url', 2048).notNullable();
    t.string('secret', 64).notNullable();
    t.specificType('events', 'text[]').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    t.index('org_id', 'idx_webhook_endpoints_org');
  });

  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('endpoint_id').notNullable().references('id').inTable('webhook_endpoints').onDelete('CASCADE');
    t.string('event_type', 100).notNullable();
    t.jsonb('payload').notNullable();
    t.integer('status_code');
    t.text('response_body');
    t.boolean('success').notNullable().defaultTo(false);
    t.timestamp('delivered_at').notNullable().defaultTo(knex.fn.now());

    t.index(['endpoint_id', 'delivered_at'], 'idx_webhook_deliveries_endpoint');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('webhook_endpoints');
}
