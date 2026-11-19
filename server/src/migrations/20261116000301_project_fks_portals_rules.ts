import type { Knex } from 'knex';

/**
 * Adds the missing FK `project_id → projects(id) ON DELETE CASCADE` on
 * `client_portals` and `automation_rules` (org-wide rules keep NULL).
 * Orphan rows (project already deleted) are removed first, otherwise the
 * constraint could not be created. down() drops the constraints only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('DELETE FROM client_portals WHERE project_id NOT IN (SELECT id FROM projects)');
  await knex.raw(
    'DELETE FROM automation_rules WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)',
  );
  await knex.raw(
    'ALTER TABLE client_portals ADD CONSTRAINT client_portals_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
  );
  await knex.raw(
    'ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_project_id_fkey');
  await knex.raw('ALTER TABLE client_portals DROP CONSTRAINT IF EXISTS client_portals_project_id_fkey');
}
