import type { Knex } from 'knex';

/**
 * Privacy features (GDPR / UK GDPR / POPIA / CCPA data-subject rights).
 *
 *  1. `users.accepted_terms_at` / `users.terms_version` — proof the account holder
 *     accepted the Terms and Privacy Policy at registration (GDPR Art. 7(1)
 *     burden of proof, POPIA s.11). Nullable: accounts created before this
 *     migration have no recorded acceptance (they are not backfilled — we do
 *     not invent consent that was never given).
 *
 *  2. The fixed "Deleted user" tombstone row. Account erasure re-points content
 *     authored by the erased person (annotations, comments, activity events,
 *     satisfaction scores) at this row, so the organisation keeps its feedback
 *     history (kept as a processor-retained record, see docs/legal/PRIVACY_POLICY.md)
 *     without it being attributable to the person. It has no password, is
 *     unverified (login is refused), no membership, and a reserved `.invalid`
 *     address (RFC 2606) that can never receive mail.
 *
 *  3. `audit_logs` stays append-only, with ONE narrow exception: an UPDATE that
 *     changes nothing except clearing `actor_id`, `ip_address` and
 *     `user_agent` to NULL. That is what lets erasure scrub the personal data
 *     (IP / browser string / actor link) out of audit events about the erased
 *     person while the event itself (what happened, when, to which resource)
 *     stays immutable. Every other UPDATE/DELETE/TRUNCATE is still rejected.
 */

export const DELETED_USER_ID = '00000000-0000-0000-0000-00000000dead';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('accepted_terms_at', { useTz: true }).nullable();
    t.string('terms_version', 32).nullable();
  });

  await knex.raw(
    `INSERT INTO users (id, email, password_hash, name, verified)
     VALUES (?, 'deleted-user@pinpoint.invalid', NULL, 'Deleted user', false)
     ON CONFLICT (id) DO NOTHING`,
    [DELETED_USER_ID],
  );

  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') AND pg_trigger_depth() > 1 THEN
        -- Referential action (org cascade / actor SET NULL): allowed.
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE'
         AND NEW.actor_id IS NULL AND NEW.ip_address IS NULL AND NEW.user_agent IS NULL
         AND (NEW.id, NEW.org_id, NEW.action, NEW.resource_type, NEW.resource_id,
              NEW.metadata, NEW.created_at, NEW.request_id)
             IS NOT DISTINCT FROM
             (OLD.id, OLD.org_id, OLD.action, OLD.resource_type, OLD.resource_id,
              OLD.metadata, OLD.created_at, OLD.request_id) THEN
        -- Privacy scrub: only the personal-data columns are cleared.
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Restore the strict (pre-privacy) append-only function.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') AND pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;
  `);
  // The tombstone row is only removed when nothing references it any more.
  await knex.raw(
    `DELETE FROM users u WHERE u.id = ?
       AND NOT EXISTS (SELECT 1 FROM annotations WHERE author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM comments WHERE author_id = u.id)`,
    [DELETED_USER_ID],
  );
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('terms_version');
    t.dropColumn('accepted_terms_at');
  });
}
