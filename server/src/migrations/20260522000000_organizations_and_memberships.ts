import type { Knex } from 'knex';

/**
 * Multi-tenancy foundation: organizations table.
 * Organizations are the top-level tenant boundary. All data is scoped to an org.
 * The existing `teams` table becomes a sub-grouping within an org (Phase 2+).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organizations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('name', 255).notNullable();
    t.string('slug', 100).notNullable().unique();
    t.string('plan', 50).notNullable().defaultTo('free');
    t.string('stripe_customer_id', 255);
    t.string('stripe_subscription_id', 255);
    t.string('plan_status', 50).defaultTo('active');
    t.jsonb('plan_limits').notNullable().defaultTo(JSON.stringify({
      seats: 2,
      annotations_per_month: 50,
      projects: 2,
      integrations: 1,
    }));
    t.timestamp('trial_ends_at');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('memberships', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('role', 50).notNullable().defaultTo('member');
    t.uuid('invited_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('accepted_at');
    t.timestamps(true, true);
    t.unique(['org_id', 'user_id']);
  });

  await knex.schema.createTable('invitations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.string('email', 255).notNullable();
    t.string('role', 50).notNullable().defaultTo('member');
    t.string('token', 255).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Add org_id to projects (nullable for now — backfill next)
  await knex.schema.alterTable('projects', (t) => {
    t.uuid('org_id').references('id').inTable('organizations').onDelete('CASCADE');
  });

  // Add org_id to annotations
  await knex.schema.alterTable('annotations', (t) => {
    t.uuid('org_id').references('id').inTable('organizations').onDelete('CASCADE');
  });

  // Indexes
  await knex.schema.alterTable('memberships', (t) => {
    t.index(['org_id', 'role'], 'idx_memberships_org_role');
    t.index(['user_id'], 'idx_memberships_user');
  });

  await knex.schema.alterTable('projects', (t) => {
    t.index(['org_id'], 'idx_projects_org');
  });

  await knex.schema.alterTable('annotations', (t) => {
    t.index(['org_id'], 'idx_annotations_org');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('annotations', (t) => {
    t.dropIndex([], 'idx_annotations_org');
    t.dropColumn('org_id');
  });
  await knex.schema.alterTable('projects', (t) => {
    t.dropIndex([], 'idx_projects_org');
    t.dropColumn('org_id');
  });
  await knex.schema.dropTableIfExists('invitations');
  await knex.schema.dropTableIfExists('memberships');
  await knex.schema.dropTableIfExists('organizations');
}
