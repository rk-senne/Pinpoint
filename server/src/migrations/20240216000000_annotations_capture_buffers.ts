import type { Knex } from 'knex';

/**
 * Phase 11 / Task 27.1 — Add nullable JSONB capture buffers to `annotations`.
 *
 * Per Req 36.2 and the design (sections "Capture_Buffer" + the annotations ERD),
 * bug-report submissions whose `type=note` and `severity ∈ {Critical, Major}`
 * carry rolling console + network buffers. They are persisted as nullable JSONB
 * columns alongside the existing annotation row so the dashboard and the
 * extension can render collapsible "Console" and "Network" sections from the
 * same record.
 *
 * Up:
 *   - Add `captured_console JSONB NULL` (array of CapturedConsoleEntry, bounded to 50).
 *   - Add `captured_network JSONB NULL` (array of CapturedNetworkEntry, bounded to 50).
 *
 * Down:
 *   - Drop both columns.
 *
 * Both `hasColumn` guards make the migration idempotent so it is safe to run on
 * databases where a sibling refactor may have already added one of the columns.
 */
export async function up(knex: Knex): Promise<void> {
  const hasConsole = await knex.schema.hasColumn('annotations', 'captured_console');
  const hasNetwork = await knex.schema.hasColumn('annotations', 'captured_network');

  if (!hasConsole || !hasNetwork) {
    await knex.schema.alterTable('annotations', (t) => {
      if (!hasConsole) t.jsonb('captured_console');
      if (!hasNetwork) t.jsonb('captured_network');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasConsole = await knex.schema.hasColumn('annotations', 'captured_console');
  const hasNetwork = await knex.schema.hasColumn('annotations', 'captured_network');

  if (hasConsole || hasNetwork) {
    await knex.schema.alterTable('annotations', (t) => {
      if (hasConsole) t.dropColumn('captured_console');
      if (hasNetwork) t.dropColumn('captured_network');
    });
  }
}
