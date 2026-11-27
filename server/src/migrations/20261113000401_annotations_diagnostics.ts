import type { Knex } from 'knex';

/**
 * Mission C2 + C3 — add nullable JSONB diagnostics + session-replay columns
 * to `annotations`.
 *
 * Mission C2 (JS-error + console capture): the shared `consoleCapture`
 * module installed by both the `<script>` widget and the extension content
 * script attaches a bounded, PII-scrubbed `consoleLogs` + `jsErrors` snapshot
 * to a create-annotation payload. They are persisted as nullable JSONB
 * columns so the dashboard can render a collapsible "Console & errors"
 * section from the same annotation row.
 *
 * Mission C3 (session-replay completeness): the extension's
 * `SessionReplayRecorder` emits a bounded, redaction-applied `ReplayEvent[]`
 * captured in the seconds before submission; it is persisted here so the
 * dashboard's ReplayPlayer can load it per annotation.
 *
 * Up:
 *   - Add `console_logs   JSONB NULL` (array of ConsoleLogEntry, ≤50).
 *   - Add `js_errors      JSONB NULL` (array of JsErrorEntry, ≤50).
 *   - Add `session_replay JSONB NULL` (array of ReplayEvent).
 *
 * Down:
 *   - Drop all three columns.
 *
 * Each `hasColumn` guard keeps the migration idempotent so it is safe to run
 * on a database where a sibling change may already have added one column.
 */
export async function up(knex: Knex): Promise<void> {
  const hasConsoleLogs = await knex.schema.hasColumn('annotations', 'console_logs');
  const hasJsErrors = await knex.schema.hasColumn('annotations', 'js_errors');
  const hasSessionReplay = await knex.schema.hasColumn('annotations', 'session_replay');

  if (!hasConsoleLogs || !hasJsErrors || !hasSessionReplay) {
    await knex.schema.alterTable('annotations', (t) => {
      if (!hasConsoleLogs) t.jsonb('console_logs');
      if (!hasJsErrors) t.jsonb('js_errors');
      if (!hasSessionReplay) t.jsonb('session_replay');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasConsoleLogs = await knex.schema.hasColumn('annotations', 'console_logs');
  const hasJsErrors = await knex.schema.hasColumn('annotations', 'js_errors');
  const hasSessionReplay = await knex.schema.hasColumn('annotations', 'session_replay');

  if (hasConsoleLogs || hasJsErrors || hasSessionReplay) {
    await knex.schema.alterTable('annotations', (t) => {
      if (hasConsoleLogs) t.dropColumn('console_logs');
      if (hasJsErrors) t.dropColumn('js_errors');
      if (hasSessionReplay) t.dropColumn('session_replay');
    });
  }
}
