import type { Knex } from 'knex';

/**
 * Phase 2 / Task 5.6 — JSONB expression index for analytics "By Browser".
 *
 * Adds a btree index on the `browserFamily` key inside the `annotations.environment`
 * JSONB column so that the analytics aggregation:
 *
 *   SELECT environment->>'browserFamily' AS browser, COUNT(*)
 *   FROM annotations
 *   WHERE project_id = $1
 *   GROUP BY 1;
 *
 * can be served from an index lookup rather than a heap scan (Reqs 16.1, 17.5).
 *
 * The index is created via `knex.raw` because Knex's schema builder cannot express
 * an expression-on-JSONB index (`((environment->>'browserFamily'))`).
 *
 * The `annotations` table inherits a `browser_meta` JSONB column from the initial
 * schema; the `environment` column itself is not added by an earlier migration
 * (task 1.4 only edits shared TypeScript types/Zod schemas), so this migration
 * adds it as a nullable JSONB column up-front and the index targets that column.
 * The column is left nullable here; later application logic (Req 17.3) is what
 * guarantees newly created rows always populate it.
 */
const INDEX_NAME = 'annotations_environment_browser_idx';

export async function up(knex: Knex): Promise<void> {
  // Add `environment` JSONB NULL if it isn't already present. Use a guarded
  // ALTER so the migration is safe to run on databases where an earlier
  // refactor has already introduced the column.
  const hasEnvironment = await knex.schema.hasColumn('annotations', 'environment');
  if (!hasEnvironment) {
    await knex.schema.alterTable('annotations', (t) => {
      t.jsonb('environment');
    });
  }

  // Expression index — must go through raw SQL because Knex's index builder
  // cannot express `((environment->>'browserFamily'))`.
  await knex.raw(
    `CREATE INDEX ${INDEX_NAME} ON annotations ((environment->>'browserFamily'))`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);

  // Only drop the column if this migration was the one that added it.
  // (We can't tell at runtime, so be conservative: drop it on `down`,
  // matching the symmetric inverse of `up`. If a downstream migration
  // had already created `environment` and depends on it, that migration's
  // own `down` would have run first under `migrate:rollback`.)
  const hasEnvironment = await knex.schema.hasColumn('annotations', 'environment');
  if (hasEnvironment) {
    await knex.schema.alterTable('annotations', (t) => {
      t.dropColumn('environment');
    });
  }
}
