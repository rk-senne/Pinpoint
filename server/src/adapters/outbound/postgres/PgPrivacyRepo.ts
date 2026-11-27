// PgPrivacyRepo — Postgres adapter for the data-subject-rights use cases.
//
// Tenant context (PP-08):
//   * user-scoped work spans orgs, so it runs in the trusted SYSTEM context
//     (`runAsSystem`, server code only) and EVERY query is predicated on the
//     requesting user id — never on request-supplied identifiers;
//   * org-scoped export runs in the org's own context (`runAsOrg`), so RLS
//     itself confines it to that tenant in addition to the explicit predicates;
//   * erasure runs in the system context inside one transaction, with every
//     statement predicated on the user id / org id being erased.

import type { Knex } from 'knex';

import { runAsOrg, runAsSystem } from '../../../infrastructure/tenantContext.js';
import type { ArchiveWriter } from '../../../domain/privacy/ports/ArchiveWriter.js';
import type {
  AccountErasureOutcome,
  OrgErasureOutcome,
  OrgSummary,
  PrivacyRepo,
  UserAuthRecord,
  UserMembershipSummary,
} from '../../../domain/privacy/ports/PrivacyRepo.js';

/** Fixed tombstone user (created by migration 20261127000101_privacy_features). */
export const DELETED_USER_ID = '00000000-0000-0000-0000-00000000dead';
const BATCH = 200;

type Row = Record<string, unknown>;

function hasActiveSub(row: { stripe_subscription_id?: unknown; plan_status?: unknown }): boolean {
  return Boolean(row.stripe_subscription_id) && row.plan_status !== 'canceled';
}

export class PgPrivacyRepo implements PrivacyRepo {
  constructor(private readonly db: Knex) {}

  // ---- lookups ------------------------------------------------------------

  getUserAuth(userId: string): Promise<UserAuthRecord | null> {
    return runAsSystem(async () => {
      const row = await this.db('users').where({ id: userId }).first('email', 'password_hash');
      return row ? { email: String(row.email), passwordHash: (row.password_hash as string | null) ?? null } : null;
    });
  }

  getUserMemberships(userId: string): Promise<UserMembershipSummary[]> {
    return runAsSystem(async () => {
      const rows = await this.db('memberships as m')
        .join('organizations as o', 'o.id', 'm.org_id')
        .where('m.user_id', userId)
        .select(
          'm.org_id',
          'm.role',
          'o.name',
          'o.stripe_subscription_id',
          'o.plan_status',
          this.db.raw('(select count(*)::int from memberships x where x.org_id = m.org_id) as member_count'),
          this.db.raw(
            "(select count(*)::int from memberships x where x.org_id = m.org_id and x.role = 'owner') as owner_count",
          ),
        );
      return rows.map((r: Row) => ({
        orgId: String(r.org_id),
        orgName: String(r.name),
        role: String(r.role),
        memberCount: Number(r.member_count),
        ownerCount: Number(r.owner_count),
        hasActiveSubscription: hasActiveSub(r),
      }));
    });
  }

  getOrg(orgId: string): Promise<OrgSummary | null> {
    return runAsOrg(orgId, async () => {
      const row = await this.db('organizations')
        .where({ id: orgId })
        .first('id', 'name', 'stripe_subscription_id', 'plan_status');
      return row ? { id: String(row.id), name: String(row.name), hasActiveSubscription: hasActiveSub(row) } : null;
    });
  }

  // ---- export -------------------------------------------------------------

  /** Keyset-paginate `base` (must select `id`) into the writer's open array. */
  private async pageInto(
    writer: ArchiveWriter,
    base: () => Knex.QueryBuilder,
    map: (r: Row) => unknown = (r) => r,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const q = base().orderBy('id', 'asc').limit(BATCH);
      if (after) q.andWhere('id', '>', after);
      const rows: Row[] = await q;
      for (const r of rows) {
        if (!(await writer.item(map(r)))) return;
      }
      if (rows.length < BATCH) return;
      after = String(rows[rows.length - 1]!.id);
    }
  }

  private async section(
    writer: ArchiveWriter,
    name: string,
    base: () => Knex.QueryBuilder,
    map?: (r: Row) => unknown,
  ): Promise<void> {
    await writer.beginArray(name);
    await this.pageInto(writer, base, map);
    await writer.endArray();
  }

  streamUserExport(userId: string, writer: ArchiveWriter): Promise<void> {
    return runAsSystem(async () => {
      const db = this.db;
      const user = await db('users')
        .where({ id: userId })
        .first(
          'id', 'email', 'name', 'avatar_url', 'verified', 'pending_email',
          'notification_preferences', 'created_at', 'updated_at', 'accepted_terms_at', 'terms_version',
        );
      await writer.value('profile', user ?? null);
      const email = user ? String(user.email) : '';

      await writer.value(
        'signInProviders',
        await db('oauth_accounts').where({ user_id: userId }).select('provider', 'email', 'name', 'avatar_url', 'created_at'),
      );
      await writer.value(
        'memberships',
        await db('memberships as m')
          .join('organizations as o', 'o.id', 'm.org_id')
          .where('m.user_id', userId)
          .select('m.org_id', 'o.name as org_name', 'm.role', 'm.accepted_at', 'm.created_at'),
      );
      await writer.value(
        'teams',
        await db('team_members as tm')
          .join('teams as t', 't.id', 'tm.team_id')
          .where('tm.user_id', userId)
          .select('t.id as team_id', 't.name', 'tm.role', 'tm.joined_at'),
      );
      await writer.value(
        'notificationPreferences',
        await db('notification_preferences').where({ user_id: userId }).select('org_id', 'mention', 'comment_on_own', 'status_change', 'project_activity'),
      );
      await writer.value(
        'apiKeys',
        await db('api_keys').where({ created_by: userId }).select('id', 'org_id', 'name', 'key_prefix', 'key_type', 'scopes', 'created_at', 'last_used_at', 'revoked_at'),
      );
      await writer.value(
        'pendingInvitations',
        email ? await db('invitations').whereRaw('lower(email) = lower(?)', [email]).select('id', 'org_id', 'role', 'expires_at', 'created_at') : [],
      );
      await writer.value(
        'satisfactionRatings',
        await db('satisfaction_scores').where(function w() { this.where('reporter_id', userId).orWhere('resolver_id', userId); })
          .select('id', 'annotation_id', 'org_id', 'score', 'comment', 'requested_at', 'rated_at'),
      );
      // Queued e-mails: kind/status only — the payload carries one-time links.
      await writer.value(
        'queuedEmails',
        await db('notifications')
          .whereRaw("payload->>'recipientUserId' = ?", [userId])
          .select('id', db.raw("payload->>'kind' as kind"), 'status', 'created_at'),
      );

      await this.section(writer, 'inAppNotifications', () => db('user_notifications').where({ user_id: userId }));
      await this.section(writer, 'activityEvents', () => db('activity_events').where({ actor_id: userId }).select('id', 'project_id', 'action', 'resource_type', 'resource_id', 'created_at'));
      await this.section(
        writer,
        'auditEvents',
        () =>
          db('audit_logs')
            .where(function w() {
              this.where('actor_id', userId).orWhere(function y() {
                this.where('resource_type', 'user').andWhere('resource_id', userId);
              });
            })
            .select('id', 'org_id', 'actor_id', 'action', 'resource_type', 'resource_id', 'metadata', 'ip_address', 'user_agent', 'created_at'),
      );
      await this.section(writer, 'projectsOwned', () => db('projects').where({ owner_id: userId }).select('id', 'org_id', 'name', 'urls', 'status', 'created_at'));
      await this.section(
        writer,
        'annotationsAssignedToMe',
        () => db('annotations').where({ assignee_id: userId }).select('id', 'org_id', 'project_id', 'pin_number', 'status', 'due_date'),
      );
      await this.section(
        writer,
        'comments',
        () => db('comments').where({ author_id: userId }).select('id', 'org_id', 'annotation_id', 'body', 'mentions', 'created_at'),
        (r) => ({ ...r, link: `/api/v1/annotations/${String(r.annotation_id)}/comments` }),
      );
      // Largest section last: annotations (with captures) and screenshot links.
      await this.section(
        writer,
        'annotations',
        () =>
          db('annotations')
            .where({ author_id: userId })
            .select(
              'id', 'org_id', 'project_id', 'page_id', 'type', 'severity', 'status', 'body', 'target',
              'environment', 'browser_meta', 'pin_number', 'screenshot_object_key', 'console_logs', 'js_errors',
              'session_replay', 'created_at', 'updated_at',
            ),
        (r) => {
          const { screenshot_object_key: key, ...rest } = r;
          return { ...rest, hasScreenshot: Boolean(key), screenshotLink: key ? `/api/v1/annotations/${String(r.id)}/screenshot` : null };
        },
      );
    });
  }

  streamOrgExport(orgId: string, writer: ArchiveWriter): Promise<void> {
    return runAsOrg(orgId, async () => {
      const db = this.db;
      await writer.value(
        'organization',
        (await db('organizations').where({ id: orgId }).first('id', 'name', 'slug', 'plan', 'plan_status', 'created_at')) ?? null,
      );
      await writer.value(
        'members',
        await db('memberships as m')
          .join('users as u', 'u.id', 'm.user_id')
          .where('m.org_id', orgId)
          .select('u.id as user_id', 'u.name', 'u.email', 'm.role', 'm.accepted_at', 'm.created_at'),
      );
      await writer.value('teams', await db('teams').where({ org_id: orgId }).select('id', 'name', 'owner_id', 'created_at'));
      await writer.value('guidelines', await db('guidelines').where({ org_id: orgId }).select('id', 'name', 'description', 'is_default'));
      await writer.value(
        'integrations',
        await db('integrations').where({ org_id: orgId }).select('id', 'provider', 'enabled', 'created_at'),
      );
      await writer.value(
        'webhookEndpoints',
        await db('webhook_endpoints').where({ org_id: orgId }).select('id', 'url', 'events', 'active', 'created_at'),
      );
      await writer.value(
        'apiKeys',
        await db('api_keys').where({ org_id: orgId }).select('id', 'name', 'key_prefix', 'key_type', 'scopes', 'created_by', 'created_at', 'revoked_at'),
      );
      await writer.value('portals', await db('client_portals').where({ org_id: orgId }));
      await writer.value(
        'automationRules',
        await db('automation_rules').where({ org_id: orgId }).select('id', 'project_id', 'name', 'active', 'trigger_event', 'conditions', 'action_type', 'action_params', 'priority'),
      );
      await writer.value('slaPolicies', await db('sla_policies').where({ org_id: orgId }));
      await writer.value('feedbackBoards', await db('feedback_boards').where({ org_id: orgId }));

      await this.section(writer, 'projects', () => db('projects').where({ org_id: orgId }));
      await this.section(
        writer,
        'pages',
        () => db('pages as pg').join('projects as p', 'p.id', 'pg.project_id').where('p.org_id', orgId).select('pg.id', 'pg.project_id', 'pg.url', 'pg.title', 'pg.created_at').orderBy('pg.id'),
      );
      await this.section(writer, 'comments', () => db('comments').where({ org_id: orgId }));
      await this.section(
        writer,
        'auditEvents',
        () => db('audit_logs').where({ org_id: orgId }).select('id', 'actor_id', 'action', 'resource_type', 'resource_id', 'metadata', 'ip_address', 'created_at'),
      );
      await this.section(
        writer,
        'annotations',
        () => db('annotations').where({ org_id: orgId }),
        (r) => {
          const { screenshot_object_key: key, ...rest } = r;
          return { ...rest, hasScreenshot: Boolean(key), screenshotLink: key ? `/api/v1/annotations/${String(r.id)}/screenshot` : null };
        },
      );
    });
  }

  // ---- erasure ------------------------------------------------------------

  async eraseAccount(userId: string): Promise<AccountErasureOutcome | { blockedOrgs: string[] }> {
    if (userId === DELETED_USER_ID) return { blockedOrgs: [] };
    return runAsSystem(() =>
      this.db.transaction(async (trx) => {
        const user = await trx('users').where({ id: userId }).forUpdate().first('id', 'email');
        if (!user) return { orgsDeleted: [], orgsLeft: [], screenshotKeys: [] };
        const email = String(user.email);

        const mem: Row[] = await trx('memberships as m')
          .where('m.user_id', userId)
          .select(
            'm.org_id',
            'm.role',
            trx.raw('(select count(*)::int from memberships x where x.org_id = m.org_id) as member_count'),
            trx.raw("(select count(*)::int from memberships x where x.org_id = m.org_id and x.role = 'owner') as owner_count"),
          );
        const blocked = mem.filter((m) => m.role === 'owner' && Number(m.owner_count) <= 1 && Number(m.member_count) > 1);
        if (blocked.length > 0) return { blockedOrgs: blocked.map((m) => String(m.org_id)) };

        const orgsDeleted: string[] = [];
        const orgsLeft: string[] = [];
        const screenshotKeys: string[] = [];

        for (const m of mem) {
          const orgId = String(m.org_id);
          if (Number(m.member_count) <= 1) {
            screenshotKeys.push(...(await this.collectScreenshotKeys(trx, orgId)));
            await trx('organizations').where({ id: orgId }).del();
            orgsDeleted.push(orgId);
            continue;
          }
          // Hand projects/teams the user owns to another member so deleting the
          // user row cannot cascade-delete the organisation's content.
          const heir = await trx('memberships')
            .where({ org_id: orgId })
            .whereNot({ user_id: userId })
            .orderByRaw("case role when 'owner' then 0 when 'admin' then 1 else 2 end, created_at asc")
            .first('user_id');
          if (heir) {
            await trx('projects').where({ org_id: orgId, owner_id: userId }).update({ owner_id: heir.user_id });
            await trx('teams').where({ org_id: orgId, owner_id: userId }).update({ owner_id: heir.user_id });
          }
          orgsLeft.push(orgId);
        }

        // Anything still owned outside any org membership (legacy rows) goes to the tombstone.
        await trx('projects').where({ owner_id: userId }).update({ owner_id: DELETED_USER_ID });
        await trx('teams').where({ owner_id: userId }).update({ owner_id: DELETED_USER_ID });

        // Anonymise authored content (retained for the organisation).
        await trx('annotations').where({ author_id: userId }).update({ author_id: DELETED_USER_ID });
        await trx('comments').where({ author_id: userId }).update({ author_id: DELETED_USER_ID });
        await trx.raw('UPDATE comments SET mentions = array_remove(mentions, ?) WHERE ? = ANY(mentions)', [userId, userId]);
        await trx('activity_events').where({ actor_id: userId }).update({ actor_id: DELETED_USER_ID });
        await trx('satisfaction_scores').where({ reporter_id: userId }).update({ reporter_id: DELETED_USER_ID });
        await trx('satisfaction_scores').where({ resolver_id: userId }).update({ resolver_id: null });

        // Rows keyed by this person's e-mail address (guest / board / portal / invite data).
        await trx('annotations')
          .whereRaw('lower(guest_email) = lower(?)', [email])
          .update({ guest_email: null, guest_name: 'Deleted user' });
        await trx('board_votes').whereRaw('lower(voter_email) = lower(?)', [email]).del();
        await trx('board_posts')
          .whereRaw('lower(author_email) = lower(?)', [email])
          .update({ author_email: 'deleted-user@pinpoint.invalid', author_name: 'Deleted user' });
        await trx('portal_sessions').whereRaw('lower(email) = lower(?)', [email]).del();
        await trx('invitations').whereRaw('lower(email) = lower(?)', [email]).del();

        // Queued e-mails addressed to the user (payloads hold the address + one-time links).
        await trx('notifications')
          .whereRaw("payload->>'recipientUserId' = ? OR lower(payload->>'recipientEmail') = lower(?)", [userId, email])
          .del();

        // Audit events stay (append-only evidence) but lose personal data: the
        // trigger permits ONLY nulling actor_id / ip_address / user_agent.
        await trx('audit_logs')
          .where({ actor_id: userId })
          .update({ actor_id: null, ip_address: null, user_agent: null });

        // Cascades: memberships, team_members, auth_tokens, oauth_accounts,
        // notification_preferences, user_notifications, api_keys created by the
        // user (their automation keys stop working — documented).
        await trx('users').where({ id: userId }).del();

        await trx('audit_logs').insert({
          org_id: null,
          actor_id: null,
          action: 'privacy.account_deleted',
          resource_type: 'user',
          // Opaque id of an account that no longer exists: proves the erasure
          // happened without identifying anyone.
          resource_id: userId,
          metadata: JSON.stringify({ orgsDeleted: orgsDeleted.length, orgsLeft: orgsLeft.length }),
        });
        return { orgsDeleted, orgsLeft, screenshotKeys };
      }),
    );
  }

  eraseOrg(orgId: string, actorId: string): Promise<OrgErasureOutcome> {
    return runAsSystem(() =>
      this.db.transaction(async (trx) => {
        const screenshotKeys = await this.collectScreenshotKeys(trx, orgId);
        // FKs `ON DELETE CASCADE` remove every org-scoped row (and, through
        // their parents, pages/shared links/tags/replies/…).
        await trx('organizations').where({ id: orgId }).del();
        // The org's own audit trail cascades away with it; the deletion event
        // is recorded with no org and no PII (opaque ids only).
        await trx('audit_logs').insert({
          org_id: null,
          actor_id: actorId,
          action: 'privacy.org_deleted',
          resource_type: 'organization',
          resource_id: orgId,
          metadata: JSON.stringify({ screenshotObjects: screenshotKeys.length }),
        });
        return { screenshotKeys };
      }),
    );
  }

  private async collectScreenshotKeys(trx: Knex.Transaction, orgId: string): Promise<string[]> {
    const rows: Row[] = await trx('annotations')
      .where({ org_id: orgId })
      .whereNotNull('screenshot_object_key')
      .select('screenshot_object_key');
    return rows.map((r) => String(r.screenshot_object_key));
  }
}
