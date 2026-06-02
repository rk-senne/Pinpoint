import type { Knex } from 'knex';

/**
 * Enable Row-Level Security on tenant-scoped tables.
 * RLS ensures data isolation at the database level — even if application
 * code has a bug, cross-tenant data access is impossible.
 *
 * The application sets `app.current_org_id` at the start of each transaction.
 */
export async function up(knex: Knex): Promise<void> {
  // Enable RLS on tenant tables
  await knex.raw('ALTER TABLE projects ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE annotations ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE comments ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE shared_links ENABLE ROW LEVEL SECURITY');

  // Policy: projects visible only to current org
  await knex.raw(`
    CREATE POLICY tenant_isolation_projects ON projects
      USING (org_id = current_setting('app.current_org_id', true)::uuid)
  `);

  // Policy: annotations visible only to current org
  await knex.raw(`
    CREATE POLICY tenant_isolation_annotations ON annotations
      USING (org_id = current_setting('app.current_org_id', true)::uuid)
  `);

  // Policy: comments visible by direct org_id
  await knex.raw(`
    CREATE POLICY tenant_isolation_comments ON comments
      USING (org_id = current_setting('app.current_org_id', true)::uuid)
  `);

  // Policy: shared_links visible via project's org
  await knex.raw(`
    CREATE POLICY tenant_isolation_shared_links ON shared_links
      USING (project_id IN (
        SELECT id FROM projects
        WHERE org_id = current_setting('app.current_org_id', true)::uuid
      ))
  `);

  // Force RLS even for table owner (defense in depth)
  await knex.raw('ALTER TABLE projects FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE annotations FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE comments FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE shared_links FORCE ROW LEVEL SECURITY');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE shared_links NO FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE comments NO FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE annotations NO FORCE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE projects NO FORCE ROW LEVEL SECURITY');

  await knex.raw('DROP POLICY IF EXISTS tenant_isolation_shared_links ON shared_links');
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation_comments ON comments');
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation_annotations ON annotations');
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation_projects ON projects');

  await knex.raw('ALTER TABLE shared_links DISABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE comments DISABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE annotations DISABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE projects DISABLE ROW LEVEL SECURITY');
}
