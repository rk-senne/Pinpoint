import type { Knex } from 'knex';

/**
 * Add org_id to comments table for direct tenant scoping.
 * This allows RLS to check org_id directly rather than joining through annotations.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('comments', (t) => {
    t.uuid('org_id').references('id').inTable('organizations').onDelete('CASCADE');
  });
  await knex.schema.alterTable('comments', (t) => {
    t.index(['org_id'], 'idx_comments_org');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('comments', (t) => {
    t.dropIndex([], 'idx_comments_org');
    t.dropColumn('org_id');
  });
}
