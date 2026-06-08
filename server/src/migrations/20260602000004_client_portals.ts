import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('client_portals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.uuid('project_id').notNullable();
    t.string('slug', 100).notNullable().unique();
    t.string('title').notNullable();
    t.text('welcome_message');
    t.string('brand_color', 7).defaultTo('#4f46e5');
    t.string('logo_url', 2048);
    t.boolean('allow_new_feedback').notNullable().defaultTo(true);
    t.boolean('require_email').notNullable().defaultTo(true);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    t.index('org_id', 'idx_client_portals_org');
  });

  await knex.schema.createTable('portal_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('portal_id').notNullable().references('id').inTable('client_portals').onDelete('CASCADE');
    t.string('email').notNullable();
    t.string('name');
    t.string('token', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('portal_sessions');
  await knex.schema.dropTableIfExists('client_portals');
}
