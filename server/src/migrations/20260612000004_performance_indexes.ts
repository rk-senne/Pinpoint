import type { Knex } from 'knex';

/**
 * Performance Enhancement 6 — composite indexes on hot query paths.
 * See docs/PERFORMANCE_SPEC.md § Enhancement 6.
 */
export async function up(knex: Knex): Promise<void> {
  // annotations: filtered list by status + chronological order
  await knex.schema.raw(
    `CREATE INDEX idx_annotations_project_status_created
     ON annotations (project_id, status, created_at DESC)`,
  );
  // annotations: org-scoped reporting (30-day window)
  await knex.schema.raw(
    `CREATE INDEX idx_annotations_org_created
     ON annotations (org_id, created_at DESC)`,
  );
  // comments: chronological listing per annotation
  await knex.schema.raw(
    `CREATE INDEX idx_comments_annotation_created
     ON comments (annotation_id, created_at ASC)`,
  );
  // comments: org-scoped team activity reporting
  await knex.schema.raw(
    `CREATE INDEX idx_comments_org_created
     ON comments (org_id, created_at DESC)`,
  );
  // board_posts: sorted by votes per board
  await knex.schema.raw(
    `CREATE INDEX idx_board_posts_board_votes
     ON board_posts (board_id, vote_count DESC)`,
  );
  // automation_rules: rule evaluation on trigger events
  await knex.schema.raw(
    `CREATE INDEX idx_automation_rules_org_trigger_active
     ON automation_rules (org_id, trigger_event, active)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_annotations_project_status_created');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_annotations_org_created');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_comments_annotation_created');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_comments_org_created');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_board_posts_board_votes');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_automation_rules_org_trigger_active');
}
