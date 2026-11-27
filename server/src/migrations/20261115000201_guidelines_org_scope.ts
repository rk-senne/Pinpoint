import type { Knex } from 'knex';

/**
 * Security: custom guidelines leaked across orgs because `guidelines` had no
 * tenant column and `GET /guidelines` returned every row.
 *
 *  - adds `org_id` (FK organizations, ON DELETE CASCADE);
 *  - backfills custom rows from the creator's earliest membership;
 *  - adds CHECK (is_default OR org_id IS NOT NULL) so a custom guideline can
 *    never again be created without an owning org. The constraint is added
 *    NOT VALID: unattributable legacy rows (creator deleted / no membership)
 *    are kept but stay invisible to every org (the list query only returns
 *    defaults + the caller's org), instead of being destroyed or left global.
 *    New and updated rows are still checked.
 *
 * Defaults (`is_default = true`) stay global with `org_id` NULL.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('guidelines', (t) => {
    t.uuid('org_id').references('id').inTable('organizations').onDelete('CASCADE');
    t.index(['org_id'], 'idx_guidelines_org');
  });

  await knex.raw(`
    UPDATE guidelines g
       SET org_id = (
         SELECT m.org_id FROM memberships m
          WHERE m.user_id = g.created_by_user_id
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT 1)
     WHERE g.is_default = false
       AND g.org_id IS NULL
       AND g.created_by_user_id IS NOT NULL
  `);

  await knex.raw(`
    ALTER TABLE guidelines
      ADD CONSTRAINT guidelines_custom_requires_org
      CHECK (is_default OR org_id IS NOT NULL) NOT VALID
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE guidelines DROP CONSTRAINT IF EXISTS guidelines_custom_requires_org');
  await knex.schema.alterTable('guidelines', (t) => {
    t.dropIndex(['org_id'], 'idx_guidelines_org');
    t.dropColumn('org_id');
  });
}
