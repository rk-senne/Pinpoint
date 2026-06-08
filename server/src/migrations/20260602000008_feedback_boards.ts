import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('feedback_boards', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable();
    t.uuid('project_id').notNullable();
    t.string('slug', 100).notNullable().unique();
    t.string('title').notNullable();
    t.text('description');
    t.boolean('allow_submissions').notNullable().defaultTo(true);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('board_posts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('board_id').notNullable().references('id').inTable('feedback_boards').onDelete('CASCADE');
    t.string('title').notNullable();
    t.text('body').notNullable();
    t.string('author_email').notNullable();
    t.string('author_name');
    t.string('status', 20).notNullable().defaultTo('open'); // open, planned, in_progress, done
    t.integer('vote_count').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('board_votes', (t) => {
    t.uuid('board_id').notNullable();
    t.uuid('post_id').notNullable().references('id').inTable('board_posts').onDelete('CASCADE');
    t.string('voter_email').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['post_id', 'voter_email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('board_votes');
  await knex.schema.dropTableIfExists('board_posts');
  await knex.schema.dropTableIfExists('feedback_boards');
}
