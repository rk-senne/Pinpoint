import type { Knex } from 'knex';

/**
 * PP-04 — teams become tenant-scoped.
 *
 * Adds `teams.org_id` (FK organizations ON DELETE CASCADE), backfilled from
 * the team owner's org (the owner's oldest membership). Teams whose owner has
 * no membership at all can't be attributed to any org and are removed (they
 * were already unreachable from every org's UI; projects referencing them fall
 * back to `team_id = NULL` via the existing ON DELETE SET NULL; team_members
 * cascade). Then the column is made NOT NULL.
 *
 * down() drops the column; deleted orphan teams are not restored.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('teams', (t) => {
    t.uuid('org_id').references('id').inTable('organizations').onDelete('CASCADE');
  });
  await knex.raw(`
    UPDATE teams t SET org_id = (
      SELECT m.org_id FROM memberships m WHERE m.user_id = t.owner_id
      ORDER BY m.created_at ASC NULLS LAST LIMIT 1
    ) WHERE t.org_id IS NULL
  `);
  await knex.raw('DELETE FROM teams WHERE org_id IS NULL');
  await knex.raw('ALTER TABLE teams ALTER COLUMN org_id SET NOT NULL');
  await knex.schema.alterTable('teams', (t) => {
    t.index(['org_id'], 'idx_teams_org');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('teams', (t) => {
    t.dropIndex(['org_id'], 'idx_teams_org');
    t.dropColumn('org_id');
  });
}
