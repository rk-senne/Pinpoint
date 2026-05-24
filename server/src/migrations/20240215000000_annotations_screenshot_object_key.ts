import type { Knex } from 'knex';

/**
 * Phase: Screenshot capture pipeline (Req 34.3 / Task 25.1).
 *
 * Adds `screenshot_object_key TEXT NULL` to the `annotations` table.
 *
 * The column stores the S3-compatible object storage key for the PNG
 * uploaded by the Extension after the annotation is created. It is
 * nullable because:
 *   - Existing annotations predate the screenshot pipeline.
 *   - Reporters can disable per-annotation screenshot attachment via
 *     the popover toggle (Req 34.2), so newly created annotations may
 *     legitimately have no screenshot.
 *
 * The screenshot bytes themselves live in S3; only the key is stored on
 * the row so the API can construct a presigned URL on demand.
 */
export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('annotations', 'screenshot_object_key');
  if (!hasColumn) {
    await knex.schema.alterTable('annotations', (t) => {
      t.text('screenshot_object_key').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('annotations', 'screenshot_object_key');
  if (hasColumn) {
    await knex.schema.alterTable('annotations', (t) => {
      t.dropColumn('screenshot_object_key');
    });
  }
}
