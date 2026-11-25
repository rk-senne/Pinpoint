import type { Knex } from 'knex';

/**
 * Enable Row-Level Security on the first tenant tables.
 *
 * SUPERSEDED (PP-08, docs/SECURITY_REVIEW.md): these original policies were
 * never effective on their own (nothing set `app.current_org_id`, and the app
 * ran as a BYPASSRLS superuser). Migration 20261125000101_row_level_security
 * drops them and installs the real, enforced policy set for every tenant table;
 * the API now connects as the unprivileged `pinpoint_app` role and pushes the
 * tenant context into each connection (infrastructure/tenantContext.ts).
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
