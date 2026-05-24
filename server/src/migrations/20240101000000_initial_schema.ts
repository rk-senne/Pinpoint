import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Enable uuid-ossp extension
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // --- users ---
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('email', 255).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('name', 255).notNullable();
    t.string('avatar_url', 1024);
    t.jsonb('notification_preferences').notNullable().defaultTo(
      JSON.stringify({
        newAnnotation: true,
        newComment: true,
        promotedToOwner: true,
        projectDeleted: true,
      })
    );
    t.timestamps(true, true);
  });

  // --- teams ---
  await knex.schema.createTable('teams', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('name', 255).notNullable();
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // --- team_members ---
  await knex.schema.createTable('team_members', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    t.string('role', 50).notNullable().defaultTo('viewer');
    t.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'team_id']);
  });

  // --- projects ---
  await knex.schema.createTable('projects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('name', 255).notNullable();
    t.specificType('urls', 'text[]').notNullable().defaultTo('{}');
    t.string('status', 50).notNullable().defaultTo('active');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('team_id').references('id').inTable('teams').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // --- guidelines ---
  await knex.schema.createTable('guidelines', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('name', 255).notNullable();
    t.text('description').notNullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.uuid('created_by_user_id').references('id').inTable('users').onDelete('SET NULL');
  });

  // --- annotations ---
  await knex.schema.createTable('annotations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('page_url', 2048).notNullable();
    t.string('type', 50).notNullable();
    t.string('severity', 50).notNullable().defaultTo('informational');
    t.string('status', 50).notNullable().defaultTo('active');
    t.text('body').notNullable();
    t.uuid('author_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.jsonb('target').notNullable();
    t.jsonb('browser_meta');
    t.uuid('guideline_id').references('id').inTable('guidelines').onDelete('SET NULL');
    t.uuid('assignee_id').references('id').inTable('users').onDelete('SET NULL');
    t.date('due_date');
    t.integer('pin_number').notNullable();
    t.timestamps(true, true);
  });

  // --- comments ---
  await knex.schema.createTable('comments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('annotation_id').notNullable().references('id').inTable('annotations').onDelete('CASCADE');
    t.uuid('author_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('body').notNullable();
    t.specificType('mentions', 'text[]').notNullable().defaultTo('{}');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // --- shared_links ---
  await knex.schema.createTable('shared_links', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('password_hash', 255);
    t.integer('failed_attempts').notNullable().defaultTo(0);
    t.timestamp('locked_until');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // --- password_resets ---
  await knex.schema.createTable('password_resets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('token_hash', 255).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.boolean('used').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // --- Indexes ---
  await knex.schema.alterTable('annotations', (t) => {
    t.index(['project_id', 'status'], 'idx_annotations_project_status');
    t.index(['project_id', 'severity'], 'idx_annotations_project_severity');
  });

  await knex.schema.alterTable('comments', (t) => {
    t.index(['annotation_id', 'created_at'], 'idx_comments_annotation_created');
  });

  await knex.schema.alterTable('team_members', (t) => {
    t.index(['team_id', 'user_id'], 'idx_team_members_team_user');
  });

  await knex.schema.alterTable('shared_links', (t) => {
    t.index(['project_id'], 'idx_shared_links_project');
  });

  await knex.schema.alterTable('users', (t) => {
    t.index(['email'], 'idx_users_email');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('password_resets');
  await knex.schema.dropTableIfExists('shared_links');
  await knex.schema.dropTableIfExists('comments');
  await knex.schema.dropTableIfExists('annotations');
  await knex.schema.dropTableIfExists('guidelines');
  await knex.schema.dropTableIfExists('projects');
  await knex.schema.dropTableIfExists('team_members');
  await knex.schema.dropTableIfExists('teams');
  await knex.schema.dropTableIfExists('users');
}
