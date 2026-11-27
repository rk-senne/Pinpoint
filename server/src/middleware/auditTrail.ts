// PP-22: security audit trail for mutations that do not record themselves.
//
// Mounted once at `/api/v1`. For every request it decides, from the method and
// path alone, whether the route is audit-relevant; if so it records ONE row to
// the append-only `audit_logs` table after the response has been sent, so a
// failing audit write can never break or delay the primary operation.
//
// Only successful mutations are recorded, with two deliberate exceptions:
// failed logins (the brute-force signal). Request/response bodies are never
// stored — metadata is limited to identifiers and coarse facts (e.g. an e-mail
// *hash* and domain, never the address, a password or a token).
//
// Routes that already call `recordAudit` themselves are intentionally absent
// from the table to avoid double rows: api_key.created/revoked,
// webhook.created/deleted, member.removed/role_changed, org.settings_updated,
// project.deleted.

import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TokenIssuer } from '../domain/auth/ports/TokenIssuer.js';
import { auditApiKeyContext, recordAudit } from '../adapters/inbound/http/auditLog.routes.js';

export interface AuditTrailDeps {
  db: Knex;
  tokenIssuer: Pick<TokenIssuer, 'verify'>;
}

interface Draft {
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  orgId?: string | null | undefined;
  actorId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface Ctx {
  req: Request;
  status: number;
  body: unknown;
  match: RegExpMatchArray;
  deps: AuditTrailDeps;
}

type Rule = {
  method: string;
  re: RegExp;
  build(ctx: Ctx): Draft | null | Promise<Draft | null>;
};

const ok = (status: number): boolean => status >= 200 && status < 400;

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 255) : undefined;
}

/** Identity of whoever the (post-auth) request ran as. */
function principal(req: Request): { orgId: string | null; actorId: string | null } {
  return { orgId: req.user?.orgId ?? null, actorId: req.user?.userId ?? null };
}

function errorCode(body: unknown): string | undefined {
  return str(obj(obj(body).error).code);
}

function emailFingerprint(email: unknown): Record<string, unknown> {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e) return {};
  const at = e.lastIndexOf('@');
  return { emailHash: sha(e).slice(0, 16), ...(at > 0 ? { emailDomain: e.slice(at + 1, at + 120) } : {}) };
}

async function userByEmail(db: Knex, email: unknown): Promise<{ id: string; orgId: string | null } | null> {
  if (typeof email !== 'string' || !email.trim()) return null;
  const user = await db('users').whereRaw('lower(email) = ?', [email.trim().toLowerCase()]).first('id');
  if (!user) return null;
  const m = await db('memberships').where({ user_id: user.id }).orderBy('created_at', 'asc').first('org_id');
  return { id: user.id as string, orgId: (m?.org_id as string | undefined) ?? null };
}

async function userByAuthToken(
  db: Knex,
  rawToken: string | undefined,
  kinds: string[],
): Promise<{ userId: string; orgId: string | null; kind: string } | null> {
  if (!rawToken) return null;
  const row = await db('auth_tokens')
    .where({ token_hash: sha(rawToken) })
    .whereIn('kind', kinds)
    .first('user_id', 'kind');
  if (!row) return null;
  const m = await db('memberships').where({ user_id: row.user_id }).orderBy('created_at', 'asc').first('org_id');
  return { userId: row.user_id as string, orgId: (m?.org_id as string | undefined) ?? null, kind: row.kind as string };
}

/** A `{ prefix.created|updated|deleted }` rule for an authenticated org-scoped resource. */
function crud(
  resourceType: string,
  base: string,
  opts: { create?: boolean; update?: boolean; remove?: boolean; createdIdKey?: string },
): Rule[] {
  const rules: Rule[] = [];
  const id = (ctx: Ctx, key?: string): string | undefined =>
    str(ctx.match[1]) ?? str(obj(ctx.body).id) ?? (key ? str(obj(obj(ctx.body)[key]).id) : undefined);
  if (opts.create)
    rules.push({
      method: 'POST',
      re: new RegExp(`^${base}/?$`),
      build: (ctx) =>
        ok(ctx.status) ? { action: `${resourceType}.created`, resourceType, resourceId: id(ctx, opts.createdIdKey), ...principal(ctx.req) } : null,
    });
  if (opts.update)
    rules.push({
      method: 'PATCH',
      re: new RegExp(`^${base}/([^/]+)/?$`),
      build: (ctx) =>
        ok(ctx.status) ? { action: `${resourceType}.updated`, resourceType, resourceId: id(ctx), ...principal(ctx.req) } : null,
    });
  if (opts.remove)
    rules.push({
      method: 'DELETE',
      re: new RegExp(`^${base}/([^/]+)/?$`),
      build: (ctx) =>
        ok(ctx.status) ? { action: `${resourceType}.deleted`, resourceType, resourceId: id(ctx), ...principal(ctx.req) } : null,
    });
  return rules;
}

export const AUDIT_RULES: Rule[] = [
  // ---- authentication -------------------------------------------------
  {
    method: 'POST',
    re: /^\/auth\/login\/?$/,
    async build({ req, status, body, deps }) {
      if (status === 200 && obj(body).mfaRequired === true) {
        // Password accepted, second factor still pending: not a session yet.
        const known = await userByEmail(deps.db, obj(req.body).email);
        return {
          action: 'auth.login_mfa_challenged',
          resourceType: 'session',
          actorId: known?.id ?? null,
          resourceId: known?.id,
          orgId: known?.orgId ?? null,
        };
      }
      if (status === 200) {
        const user = obj(obj(body).user);
        const rawToken = obj(body).token;
        const token = typeof rawToken === 'string' ? rawToken : undefined;
        let orgId: string | null = null;
        try {
          orgId = token ? deps.tokenIssuer.verify(token).orgId : null;
        } catch {
          /* leave null */
        }
        return {
          action: 'auth.login_succeeded',
          resourceType: 'session',
          actorId: str(user.id) ?? null,
          resourceId: str(user.id),
          orgId,
        };
      }
      if (status === 401 || status === 403) {
        const known = await userByEmail(deps.db, obj(req.body).email);
        return {
          action: 'auth.login_failed',
          resourceType: 'session',
          actorId: known?.id ?? null,
          resourceId: known?.id,
          orgId: known?.orgId ?? null,
          metadata: { reason: errorCode(body) ?? `http_${status}`, ...emailFingerprint(obj(req.body).email) },
        };
      }
      return null;
    },
  },
  {
    method: 'POST',
    re: /^\/auth\/login\/mfa\/?$/,
    async build({ req, status, body, deps }) {
      const actor = (req as Request & { auditActorId?: string }).auditActorId;
      if (status === 200) {
        const user = obj(obj(body).user);
        const rawToken = obj(body).token;
        let orgId: string | null = null;
        try {
          orgId = typeof rawToken === 'string' ? deps.tokenIssuer.verify(rawToken).orgId : null;
        } catch {
          /* leave null */
        }
        return {
          action: 'auth.login_succeeded',
          resourceType: 'session',
          actorId: str(user.id) ?? null,
          resourceId: str(user.id),
          orgId,
          metadata: { mfa: str(obj(body).mfaMethod) ?? 'totp' },
        };
      }
      if (!actor || ![401, 423].includes(status)) return null;
      const m = await deps.db('memberships').where({ user_id: actor }).orderBy('created_at', 'asc').first('org_id');
      return {
        action: 'auth.mfa_failed',
        resourceType: 'session',
        actorId: actor,
        resourceId: actor,
        orgId: (m?.org_id as string | undefined) ?? null,
        metadata: { reason: errorCode(body) ?? `http_${status}` },
      };
    },
  },
  {
    method: 'POST',
    re: /^\/auth\/mfa\/verify\/?$/,
    build: ({ req, status }) => (ok(status) ? { action: 'auth.mfa_enabled', resourceType: 'user', resourceId: req.user?.userId, ...principal(req) } : null),
  },
  {
    method: 'POST',
    re: /^\/auth\/mfa\/disable\/?$/,
    build: ({ req, status }) => (ok(status) ? { action: 'auth.mfa_disabled', resourceType: 'user', resourceId: req.user?.userId, ...principal(req) } : null),
  },
  {
    method: 'POST',
    re: /^\/auth\/mfa\/recovery-codes\/?$/,
    build: ({ req, status }) => (ok(status) ? { action: 'auth.mfa_recovery_codes_regenerated', resourceType: 'user', resourceId: req.user?.userId, ...principal(req) } : null),
  },
  {
    method: 'POST',
    re: /^\/auth\/logout\/?$/,
    build({ req, status }) {
      if (!ok(status) || !req.user) return null;
      return { action: 'auth.logout', resourceType: 'session', resourceId: req.user.userId, ...principal(req) };
    },
  },
  {
    method: 'POST',
    re: /^\/auth\/reset-password\/?$/,
    async build({ req, status, deps }) {
      if (!ok(status)) return null;
      const known = await userByEmail(deps.db, obj(req.body).email);
      if (!known) return null; // the endpoint answers identically for unknown addresses; so do we (no row)
      return { action: 'auth.password_reset_requested', resourceType: 'user', resourceId: known.id, actorId: known.id, orgId: known.orgId };
    },
  },
  {
    method: 'POST',
    re: /^\/auth\/reset-password\/([^/]+)\/?$/,
    async build({ status, match, deps }) {
      if (!ok(status)) return null;
      const t = await userByAuthToken(deps.db, match[1], ['reset_password']);
      if (!t) return null;
      return { action: 'auth.password_reset_completed', resourceType: 'user', resourceId: t.userId, actorId: t.userId, orgId: t.orgId };
    },
  },
  {
    method: 'POST',
    re: /^\/auth\/verify-email\/([^/]+)\/?$/,
    async build({ status, match, deps }) {
      if (!ok(status)) return null;
      const t = await userByAuthToken(deps.db, match[1], ['verify_email', 'change_email']);
      if (!t) return null;
      return {
        action: t.kind === 'change_email' ? 'auth.email_change_confirmed' : 'auth.email_verified',
        resourceType: 'user',
        resourceId: t.userId,
        actorId: t.userId,
        orgId: t.orgId,
      };
    },
  },
  {
    method: 'PUT',
    re: /^\/users\/me\/?$/,
    build({ req, status, body }) {
      if (!ok(status) || obj(body).emailChangePending !== true) return null;
      return {
        action: 'auth.email_change_requested',
        resourceType: 'user',
        resourceId: req.user?.userId,
        ...principal(req),
        metadata: emailFingerprint(obj(req.body).email),
      };
    },
  },
  {
    method: 'POST',
    re: /^\/org\/revoke-sessions\/?$/,
    build: ({ req, status }) =>
      ok(status) ? { action: 'auth.sessions_revoked', resourceType: 'user', resourceId: req.user?.userId, ...principal(req) } : null,
  },
  {
    method: 'POST',
    re: /^\/org\/switch\/?$/,
    build: ({ req, status, body }) =>
      ok(status)
        ? { action: 'org.switched', resourceType: 'organization', resourceId: str(obj(body).orgId), ...principal(req), orgId: str(obj(body).orgId) ?? req.user?.orgId ?? null }
        : null,
  },

  // ---- exports / sharing ---------------------------------------------
  {
    method: 'POST',
    re: /^\/projects\/([^/]+)\/export\/?$/,
    build: ({ req, status, match }) =>
      ok(status)
        ? { action: 'export.created', resourceType: 'project', resourceId: match[1], ...principal(req), metadata: { format: str(obj(req.body).format) } }
        : null,
  },
  {
    // The endpoint creates or updates the project's single share link.
    method: 'POST',
    re: /^\/projects\/([^/]+)\/share\/?$/,
    build: ({ req, status, match, body }) =>
      ok(status)
        ? {
            action: 'share_link.saved',
            resourceType: 'share_link',
            resourceId: str(obj(obj(body).sharedLink).id),
            ...principal(req),
            metadata: {
              projectId: match[1],
              hasPassword: obj(obj(body).sharedLink).hasPassword === true,
              allowFeedback: obj(obj(body).sharedLink).allowFeedback === true,
            },
          }
        : null,
  },
  ...crud('portal', '/portals', { create: true, update: true, remove: true, createdIdKey: 'portal' }),
  {
    method: 'POST',
    re: /^\/boards\/?$/,
    build: ({ req, status, body }) =>
      ok(status) ? { action: 'board.created', resourceType: 'board', resourceId: str(obj(obj(body).board).id), ...principal(req) } : null,
  },

  // ---- integrations / webhooks / keys ------------------------------
  {
    method: 'POST',
    re: /^\/integrations\/([^/]+)\/connect\/?$/,
    build: ({ req, status, match }) =>
      ok(status) ? { action: 'integration.connected', resourceType: 'integration', resourceId: match[1], ...principal(req) } : null,
  },
  {
    method: 'GET',
    re: /^\/integrations\/([^/]+)\/callback\/?$/,
    build: ({ req, status, match }) =>
      ok(status) ? { action: 'integration.connected', resourceType: 'integration', resourceId: match[1], ...principal(req), metadata: { via: 'oauth_callback' } } : null,
  },
  {
    method: 'DELETE',
    re: /^\/integrations\/([^/]+)\/?$/,
    build: ({ req, status, match }) =>
      ok(status) ? { action: 'integration.disconnected', resourceType: 'integration', resourceId: match[1], ...principal(req) } : null,
  },
  // webhook.created / webhook.deleted and api_key.* are recorded by their routes.
  ...crud('webhook', '/webhooks', { update: true }),

  // ---- invitations / roles / teams -----------------------------------
  {
    method: 'POST',
    re: /^\/org\/invitations\/?$/,
    build: ({ req, status, body }) =>
      ok(status)
        ? {
            action: 'invitation.created',
            resourceType: 'invitation',
            resourceId: str(obj(body).invitationId),
            ...principal(req),
            metadata: { role: str(obj(body).role), ...emailFingerprint(obj(body).email) },
          }
        : null,
  },
  {
    method: 'POST',
    re: /^\/org\/invitations\/accept\/?$/,
    build: ({ req, status, body }) =>
      ok(status)
        ? {
            action: 'invitation.accepted',
            resourceType: 'invitation',
            ...principal(req),
            orgId: str(obj(body).orgId) ?? req.user?.orgId ?? null,
            metadata: { role: str(obj(body).role) },
          }
        : null,
  },
  {
    method: 'POST',
    re: /^\/teams\/([^/]+)\/invite\/?$/,
    build: ({ req, status, match }) =>
      ok(status)
        ? { action: 'team.member_invited', resourceType: 'team', resourceId: match[1], ...principal(req), metadata: { role: str(obj(req.body).role), ...emailFingerprint(obj(req.body).email) } }
        : null,
  },
  {
    method: 'PUT',
    re: /^\/teams\/([^/]+)\/members\/([^/]+)\/?$/,
    build: ({ req, status, match }) =>
      ok(status)
        ? { action: 'team.role_changed', resourceType: 'team', resourceId: match[1], ...principal(req), metadata: { userId: match[2], role: str(obj(req.body).role) } }
        : null,
  },
  {
    method: 'DELETE',
    re: /^\/teams\/([^/]+)\/members\/([^/]+)\/?$/,
    build: ({ req, status, match }) =>
      ok(status) ? { action: 'team.member_removed', resourceType: 'team', resourceId: match[1], ...principal(req), metadata: { userId: match[2] } } : null,
  },
];

export function matchAuditRule(method: string, path: string): { rule: Rule; match: RegExpMatchArray } | null {
  for (const rule of AUDIT_RULES) {
    if (rule.method !== method) continue;
    const match = path.match(rule.re);
    if (match) return { rule, match };
  }
  return null;
}

export function createAuditTrail(deps: AuditTrailDeps): RequestHandler {
  return function auditTrail(req: Request, res: Response, next: NextFunction): void {
    const hit = matchAuditRule(req.method, req.path);
    if (!hit) {
      next();
      return;
    }

    let captured: unknown;
    const originalJson = res.json.bind(res);
    res.json = ((b: unknown) => {
      captured = b;
      return originalJson(b);
    }) as typeof res.json;

    res.on('finish', () => {
      void (async () => {
        try {
          const draft = await hit.rule.build({ req, status: res.statusCode, body: captured, match: hit.match, deps });
          if (!draft) return;
          const fallback = principal(req);
          const orgId = draft.orgId === undefined ? fallback.orgId : draft.orgId;
          const actorId = draft.actorId === undefined ? fallback.actorId : draft.actorId;
          await recordAudit(deps.db, {
            orgId,
            actorId,
            action: draft.action,
            resourceType: draft.resourceType,
            ...(draft.resourceId ? { resourceId: draft.resourceId } : {}),
            ...(draft.metadata ? { metadata: stripUndefined(draft.metadata) } : {}),
            ...auditApiKeyContext(req),
            request: req,
          });
        } catch {
          // Auditing must never affect the request that already completed.
        }
      })();
    });
    next();
  };
}

function stripUndefined(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
}
