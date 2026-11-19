import type { Knex } from 'knex';

/**
 * Finishes the guidelines tenant-scoping started in
 * 20261115000201_guidelines_org_scope, which left
 * `guidelines_custom_requires_org` as NOT VALID.
 *
 * Legacy custom rows (is_default = false) that still have no org_id could not
 * be attributed to any org (creator deleted / never a member). They are
 * invisible to every org already, so they are removed and the constraint is
 * VALIDATEd. Only rows with `org_id IS NULL AND is_default = false` are
 * touched; defaults and org-owned rows are never modified.
 *
 * To keep this reversible as far as possible, deleted rows are first copied
 * into `guidelines_unattributed_backup` (created only when there is something
 * to delete); `down()` restores them and drops the backup. Annotations that
 * referenced a deleted guideline lose that link (FK is ON DELETE SET NULL).
 */
const BACKUP_TABLE = 'guidelines_unattributed_backup';

export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: Array<{ n: string }> }>(
    'SELECT count(*)::text AS n FROM guidelines WHERE org_id IS NULL AND is_default = false',
  );
  const count = Number(rows[0]?.n ?? 0);

  if (count > 0) {
    await knex.raw(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (LIKE guidelines INCLUDING DEFAULTS)`);
    await knex.raw(
      `INSERT INTO ${BACKUP_TABLE} SELECT * FROM guidelines WHERE org_id IS NULL AND is_default = false`,
    );
    await knex.raw('DELETE FROM guidelines WHERE org_id IS NULL AND is_default = false');
  }
  // eslint-disable-next-line no-console
  console.log(`[migration] guidelines: removed ${count} unattributable legacy custom row(s) before validating constraint`);

  await knex.raw('ALTER TABLE guidelines VALIDATE CONSTRAINT guidelines_custom_requires_org');
}

export async function down(knex: Knex): Promise<void> {
  // Drop first: restoring legacy rows would violate the validated constraint.
  await knex.raw('ALTER TABLE guidelines DROP CONSTRAINT IF EXISTS guidelines_custom_requires_org');

  if (await knex.schema.hasTable(BACKUP_TABLE)) {
    await knex.raw(`INSERT INTO guidelines SELECT * FROM ${BACKUP_TABLE} ON CONFLICT (id) DO NOTHING`);
    await knex.schema.dropTable(BACKUP_TABLE);
  }

  // Return to the previous state: constraint present but NOT VALID.
  await knex.raw(`
    ALTER TABLE guidelines
      ADD CONSTRAINT guidelines_custom_requires_org
      CHECK (is_default OR org_id IS NOT NULL) NOT VALID
  `);
}
