import type { Knex } from 'knex';

/**
 * Load-test finding (docs/PERFORMANCE.md): `GET /projects/:id/annotations`
 * lists a project's annotations `ORDER BY pin_number` (optionally filtered by
 * status) with LIMIT/OFFSET, but no index covered that order. Postgres fetched
 * every row of the project and top-N sorted them, so a page view cost O(project
 * size): measured 9.2 ms (page 3) / 4.7 ms (status filter) on a 30k-annotation
 * project versus 0.045 / 0.034 ms with these indexes (~200x), and the gap grows
 * linearly with project size.
 *
 * `IF NOT EXISTS` keeps the migration re-runnable. The table lock is held only
 * for the index build (fast at current volumes); on a very large table build them
 * `CONCURRENTLY` by hand before deploying.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_annotations_project_pin ON annotations (project_id, pin_number)',
  );
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_annotations_project_status_pin ON annotations (project_id, status, pin_number)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_project_status_pin');
  await knex.raw('DROP INDEX IF EXISTS idx_annotations_project_pin');
}
