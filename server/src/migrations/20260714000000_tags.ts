import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tags', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('name', 50).notNullable();
    t.string('color', 7).notNullable().defaultTo('#6b7280'); // hex color
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['project_id', 'name']);
  });

  await knex.schema.createTable('annotation_tags', (t) => {
    t.uuid('annotation_id').notNullable().references('id').inTable('annotations').onDelete('CASCADE');
    t.uuid('tag_id').notNullable().references('id').inTable('tags').onDelete('CASCADE');
    t.primary(['annotation_id', 'tag_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('annotation_tags');
  await knex.schema.dropTableIfExists('tags');
}
