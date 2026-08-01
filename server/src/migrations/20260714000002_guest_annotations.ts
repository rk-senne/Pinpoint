import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add guest_name and guest_email to annotations for guest-submitted feedback
  await knex.schema.alterTable('annotations', (t) => {
    t.string('guest_name', 100).nullable();
    t.string('guest_email', 255).nullable();
    t.boolean('is_guest').notNullable().defaultTo(false);
  });

  // Add allow_feedback flag to shared_links
  await knex.schema.alterTable('shared_links', (t) => {
    t.boolean('allow_feedback').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('annotations', (t) => {
    t.dropColumn('guest_name');
    t.dropColumn('guest_email');
    t.dropColumn('is_guest');
  });
  await knex.schema.alterTable('shared_links', (t) => {
    t.dropColumn('allow_feedback');
  });
}
