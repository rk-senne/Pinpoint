import type { Knex } from 'knex';

/**
 * Row-Level Security as a REAL second line of tenant isolation (PP-08).
 *
 * Replaces the inert policies of 20260522000002_enable_rls. The API connects
 * as the unprivileged `pinpoint_app` role (NOSUPERUSER NOBYPASSRLS) and, on
 * every connection acquire, sets `app.current_org_id` / `app.system` from the
 * AsyncLocalStorage tenant context (server/src/infrastructure/tenantContext.ts).
 *
 * Every policy is `FOR ALL` with the same USING and WITH CHECK:
 *   - direct tables:  org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
 *                     OR current_setting('app.system', true) = 'on'
 *   - child tables:   EXISTS (parent row) — the parent's own policy applies
 *                     inside the subquery, so the check is transitive.
 * With no context both settings are empty → every predicate is false (fail
 * closed). `app.system = 'on'` is set only by server code (`runAsSystem`).
 *
 * Tables deliberately WITHOUT RLS (documented in docs/SECURITY_REVIEW.md):
 * users, oauth_accounts, auth_tokens (identity, spans orgs, looked up by
 * secret before a tenant is known), notifications (outbox, no org column),
 * knex_migrations*.
 */

const ORG = `org_id = nullif(current_setting('app.current_org_id', true), '')::uuid`;
const SYS = `current_setting('app.system', true) = 'on'`;

/** Tables with their own org_id column. */
const DIRECT = [
  'projects',
  'annotations',
  'comments',
  'api_keys',
  'approval_workflows',
  'audit_logs',
  'automation_rules',
  'client_portals',
  'feedback_boards',
  'guidelines',
  'integrations',
  'invitations',
  'memberships',
  'notification_preferences',
  'satisfaction_scores',
  'sla_policies',
  'subscription_events',
  'teams',
  'usage_records',
  'user_notifications',
  'webhook_endpoints',
];

/** child table → [fk column, parent table] (parent is itself RLS-protected). */
const CHILD: Record<string, [string, string]> = {
  pages: ['project_id', 'projects'],
  shared_links: ['project_id', 'projects'],
  tags: ['project_id', 'projects'],
  activity_events: ['project_id', 'projects'],
  annotation_external_links: ['annotation_id', 'annotations'],
  annotation_tags: ['annotation_id', 'annotations'],
  approval_instances: ['annotation_id', 'annotations'],
  sla_breaches: ['annotation_id', 'annotations'],
  board_posts: ['board_id', 'feedback_boards'],
  board_votes: ['board_id', 'feedback_boards'],
  portal_sessions: ['portal_id', 'client_portals'],
  team_members: ['team_id', 'teams'],
  webhook_deliveries: ['endpoint_id', 'webhook_endpoints'],
};

const POLICY = 'tenant_isolation';

function allTables(): string[] {
  return [...DIRECT, ...Object.keys(CHILD), 'organizations'];
}

async function createPolicy(knex: Knex, table: string, predicate: string): Promise<void> {
  await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
  await knex.raw(
    `CREATE POLICY ${POLICY} ON ${table} FOR ALL USING (${predicate}) WITH CHECK (${predicate})`,
  );
}

async function appRoleSetup(knex: Knex): Promise<void> {
  const password = process.env.DB_APP_PASSWORD;
  // DDL cannot take bind parameters; quote the literal ourselves.
  if (password) {
    const lit = `'${password.replace(/'/g, "''")}'`;
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinpoint_app') THEN
          CREATE ROLE pinpoint_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${lit};
        ELSE
          ALTER ROLE pinpoint_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${lit};
        END IF;
      END $$;
    `);
  }
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinpoint_app') THEN
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO pinpoint_app', current_database());
        GRANT USAGE ON SCHEMA public TO pinpoint_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pinpoint_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pinpoint_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pinpoint_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pinpoint_app;
      END IF;
    END $$;
  `);
}

export async function up(knex: Knex): Promise<void> {
  await appRoleSetup(knex);

  // Drop the inert 20260522000002 policies (superseded by `tenant_isolation`).
  for (const t of ['projects', 'annotations', 'comments', 'shared_links']) {
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation_${t} ON ${t}`);
  }

  // Backfill legacy rows whose org_id was never set (guest/widget annotations
  // and their comments) from the owning project, so they stay visible to their
  // tenant once policies are enforced. Disable the legacy FORCE first so a
  // non-superuser owner can see the rows it is updating.
  for (const t of ['projects', 'annotations', 'comments', 'shared_links']) {
    await knex.raw(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  }
  await knex.raw(
    `UPDATE annotations a SET org_id = p.org_id FROM projects p WHERE a.project_id = p.id AND a.org_id IS NULL AND p.org_id IS NOT NULL`,
  );
  await knex.raw(
    `UPDATE comments c SET org_id = a.org_id FROM annotations a WHERE c.annotation_id = a.id AND c.org_id IS NULL AND a.org_id IS NOT NULL`,
  );

  for (const t of DIRECT) {
    if (t === 'guidelines') continue;
    await createPolicy(knex, t, `${ORG} OR ${SYS}`);
  }
  // Built-in guidelines (org_id NULL, e.g. Nielsen's heuristics) are readable
  // by every tenant but writable only by system; tenant rows are org-scoped.
  await createPolicy(knex, 'guidelines', `${ORG} OR ${SYS}`);
  await knex.raw(`DROP POLICY IF EXISTS guidelines_builtin_read ON guidelines`);
  await knex.raw(`CREATE POLICY guidelines_builtin_read ON guidelines FOR SELECT USING (org_id IS NULL)`);

  for (const [t, [fk, parent]] of Object.entries(CHILD)) {
    await createPolicy(
      knex,
      t,
      `EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = ${t}.${fk}) OR ${SYS}`,
    );
  }

  await createPolicy(
    knex,
    'organizations',
    `id = nullif(current_setting('app.current_org_id', true), '')::uuid OR ${SYS}`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS guidelines_builtin_read ON guidelines`);
  for (const t of allTables()) {
    await knex.raw(`DROP POLICY IF EXISTS ${POLICY} ON ${t}`);
    await knex.raw(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
  }

  // Restore the previous (inert) state exactly as 20260522000002 left it.
  const legacy: Array<[string, string]> = [
    ['projects', `org_id = current_setting('app.current_org_id', true)::uuid`],
    ['annotations', `org_id = current_setting('app.current_org_id', true)::uuid`],
    ['comments', `org_id = current_setting('app.current_org_id', true)::uuid`],
    [
      'shared_links',
      `project_id IN (SELECT id FROM projects WHERE org_id = current_setting('app.current_org_id', true)::uuid)`,
    ],
  ];
  for (const [t, pred] of legacy) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation_${t} ON ${t} USING (${pred})`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  }
  // The pinpoint_app role and its grants are intentionally kept: dropping a
  // role that owns connections/privileges is not safely reversible here.
}
