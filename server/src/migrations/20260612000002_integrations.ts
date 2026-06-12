import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('integrations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.string('provider', 50).notNullable();
    t.text('access_token').notNullable();
    t.text('refresh_token');
    t.timestamp('token_expires_at');
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);

    t.unique(['org_id', 'provider'], { indexName: 'uq_integrations_org_provider' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('integrations');
}
