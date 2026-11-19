import type { Knex } from 'knex';

/**
 * PP-10 — org-scoped tables had `org_id` without a foreign key, so deleting an
 * organisation left portals, boards, webhooks (incl. signing secrets) … behind
 * (and their public slugs resolvable). Adds
 * `FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE`.
 *
 * Existing orphans (org already gone) are deleted first — they were unreachable
 * from every org and the constraint could not be created otherwise. Idempotent:
 * tables that are missing or already constrained are skipped. down() drops the
 * constraints; deleted orphans are not restored.
 */
const TABLES = [
  'approval_workflows',
  'automation_rules',
  'client_portals',
  'feedback_boards',
  'integrations',
  'notification_preferences',
  'satisfaction_scores',
  'sla_policies',
  'user_notifications',
  'webhook_endpoints',
];

const fkName = (table: string): string => `${table}_org_id_organizations_fkey`;

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    const { rows } = await knex.raw<{ rows: Array<{ ok: boolean }> }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'org_id'
                         AND data_type = 'uuid') AS ok`,
      [table],
    );
    if (!rows[0]?.ok) continue;
    const { rows: existing } = await knex.raw<{ rows: unknown[] }>(
      'SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass',
      [fkName(table), table],
    );
    if (existing.length > 0) continue;
    await knex.raw(`DELETE FROM "${table}" WHERE org_id IS NOT NULL AND org_id NOT IN (SELECT id FROM organizations)`);
    await knex.raw(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${fkName(table)}" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    await knex.raw(`ALTER TABLE IF EXISTS "${table}" DROP CONSTRAINT IF EXISTS "${fkName(table)}"`);
  }
}
