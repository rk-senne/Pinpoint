import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('org_id').notNullable();
    t.string('type', 50).notNullable();
    t.string('title').notNullable();
    t.text('body');
    t.jsonb('metadata').defaultTo('{}');
    t.boolean('read').notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.index(['user_id', 'read', 'created_at'], 'idx_user_notifications_user_unread');
  });

  await knex.schema.createTable('notification_preferences', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('org_id').notNullable();
    t.boolean('mention').notNullable().defaultTo(true);
    t.boolean('comment_on_own').notNullable().defaultTo(true);
    t.boolean('status_change').notNullable().defaultTo(true);
    t.boolean('project_activity').notNullable().defaultTo(false);
    t.primary(['user_id', 'org_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_preferences');
  await knex.schema.dropTableIfExists('user_notifications');
}
