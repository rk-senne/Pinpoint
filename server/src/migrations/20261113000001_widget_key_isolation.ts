import type { Knex } from 'knex';

/**
 * Widget key isolation (Mission A1).
 *
 * Adds per-key scoping columns so a `pk_widget_`-prefixed key is bound to
 * a single project (killing the org-wide `.orderBy('created_at').first()`
 * write primitive), can be restricted to a set of origins for the
 * dedicated widget CORS layer (A2), and carries a per-key daily quota for
 * the Redis fail-closed rate limiter (A3).
 *
 *   key_type        'standard' (default) | 'widget'
 *   project_id      target project for widget keys (NULL for standard keys)
 *   allowed_origins origins the widget CORS layer may reflect (empty = any)
 *   daily_quota     max widget submissions per UTC day (NULL = unlimited)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.string('key_type', 16).notNullable().defaultTo('standard');
    t.uuid('project_id').nullable().references('id').inTable('projects').onDelete('CASCADE');
    t.specificType('allowed_origins', 'text[]').notNullable().defaultTo('{}');
    t.integer('daily_quota').nullable();
  });

  await knex.schema.alterTable('api_keys', (t) => {
    t.index(['project_id'], 'idx_api_keys_project');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.dropIndex(['project_id'], 'idx_api_keys_project');
    t.dropColumn('key_type');
    t.dropColumn('project_id');
    t.dropColumn('allowed_origins');
    t.dropColumn('daily_quota');
  });
}
