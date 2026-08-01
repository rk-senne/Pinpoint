import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Missing indexes for common query patterns
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_annotations_page_id ON annotations (page_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_annotations_assignee_id ON annotations (assignee_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_annotations_status ON annotations (status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_annotations_severity ON annotations (severity)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_activity_events_actor ON activity_events (actor_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_comments_author ON comments (author_id)');

  // Full-text search index for annotations
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_annotations_body_fts
    ON annotations USING gin (to_tsvector('english', body))
  `);

  // Partial index for active annotations (most common query)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_annotations_active
    ON annotations (project_id, created_at DESC)
    WHERE status = 'active'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_page_id');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_assignee_id');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_status');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_severity');
  await knex.raw('DROP INDEX IF EXISTS idx_activity_events_actor');
  await knex.raw('DROP INDEX IF EXISTS idx_comments_author');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_body_fts');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_active');
}
