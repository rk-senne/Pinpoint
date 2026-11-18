import type { Knex } from 'knex';

/**
 * PP-22 — audit log hardening.
 *
 *  - new columns: `user_agent`, `request_id` (`ip_address` already exists);
 *  - `org_id` becomes nullable so pre-authentication events (failed login for
 *    an unknown e-mail) can be recorded without belonging to any tenant;
 *  - append-only: a trigger rejects UPDATE and DELETE issued by application
 *    code. Referential actions are exempt (`pg_trigger_depth() > 1` means the
 *    statement was fired from inside another trigger — the FK cascade when an
 *    organisation is deleted, or `ON DELETE SET NULL` when a user is erased),
 *    so tenant/user erasure keeps working while nobody can edit or remove an
 *    individual event. TRUNCATE is blocked too.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_logs', (t) => {
    t.text('user_agent').nullable();
    t.string('request_id', 64).nullable();
  });
  await knex.raw('ALTER TABLE audit_logs ALTER COLUMN org_id DROP NOT NULL');
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_org_resource ON audit_logs (org_id, resource_type, created_at DESC)',
  );
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_audit_logs_request ON audit_logs (request_id)');

  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') AND pg_trigger_depth() > 1 THEN
        -- Referential action (org cascade / actor SET NULL): allowed.
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs');
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
  `);
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs');
  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_no_truncate() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only (TRUNCATE rejected)'
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_no_truncate();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs');
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs');
  await knex.raw('DROP FUNCTION IF EXISTS audit_logs_no_truncate()');
  await knex.raw('DROP FUNCTION IF EXISTS audit_logs_append_only()');
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_request');
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_resource');
  // Rows recorded without an org cannot satisfy NOT NULL; they are dropped on rollback.
  await knex.raw('ALTER TABLE audit_logs DISABLE TRIGGER USER');
  await knex.raw('DELETE FROM audit_logs WHERE org_id IS NULL');
  await knex.raw('ALTER TABLE audit_logs ENABLE TRIGGER USER');
  await knex.raw('ALTER TABLE audit_logs ALTER COLUMN org_id SET NOT NULL');
  await knex.schema.alterTable('audit_logs', (t) => {
    t.dropColumn('request_id');
    t.dropColumn('user_agent');
  });
}
