// API-key-or-JWT authentication for the routes the MCP server / automation
// clients use (projects list, annotations, comments, feedback).
//
// `Authorization: Bearer pk_<hex>` (a STANDARD org API key) authenticates as
// the key's creator within the key's org, and is checked against the key's
// scopes: safe methods need `feedback:read`, mutations need
// `feedback:write`. Anything else (cookie session, JWT bearer) falls
// through to the regular JWT middleware, so dashboard + extension behaviour
// is unchanged. Widget keys (`pk_widget_…`) are always rejected here.
//
// Scopes alone are far too coarse (`feedback:write` used to unlock the whole
// projects router — a key could delete a project), so keys are additionally
// confined to an explicit allow-list of (method, route) pairs: exactly what
// the MCP server and automation clients call. Everything else answers
// 403 INSUFFICIENT_SCOPE for a key. Account, org-admin, billing, api-key
// management, webhooks and integrations stay JWT/cookie-only.
//
// A key also stops working the moment its creator is no longer a member of
// the key's org (defence in depth next to revoking the creator's keys when
// they are removed).

import type { NextFunction, Request, Response } from 'express';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';
import type { ApiKeyRepo } from '../domain/org/ports/ApiKeyRepo.js';
import type { Knex } from 'knex';
import { createApiKeyMiddleware } from './apiKeyAuth.js';
import { getRegisteredSessionDb } from '../adapters/inbound/http/access.js';

type Mw = (req: Request, res: Response, next: NextFunction) => void;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SEG = '[^/]+';
/** (method, path-after-/api/v1) pairs an org API key may call. */
const KEY_ALLOW_LIST: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/projects$/ },
  { method: 'GET', path: new RegExp(`^/projects/${SEG}$`) },
  { method: 'GET', path: /^\/feedback$/ },
  { method: 'GET', path: new RegExp(`^/feedback/${SEG}$`) },
  { method: 'PATCH', path: new RegExp(`^/feedback/${SEG}$`) },
  { method: 'GET', path: new RegExp(`^/projects/${SEG}/annotations$`) },
  { method: 'GET', path: new RegExp(`^/annotations/${SEG}$`) },
  { method: 'PUT', path: new RegExp(`^/annotations/${SEG}/status$`) },
  { method: 'GET', path: new RegExp(`^/annotations/${SEG}/comments$`) },
  { method: 'POST', path: new RegExp(`^/annotations/${SEG}/comments$`) },
];

/** Whether an API-key principal may call `method path` (path relative to /api/v1). */
export function isApiKeyRouteAllowed(method: string, rawPath: string): boolean {
  let path = rawPath.split('?')[0] ?? '';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return KEY_ALLOW_LIST.some((r) => r.method === m && r.path.test(path));
}

function relativeApiPath(req: Request): string {
  const url = req.originalUrl || `${req.baseUrl}${req.path}`;
  const idx = url.indexOf('/api/v1');
  return idx === -1 ? url : url.slice(idx + '/api/v1'.length);
}

export function createApiKeyOrJwtMiddleware(deps: {
  apiKeyRepo: ApiKeyRepo;
  jwtMiddleware: Mw;
  /** Optional; defaults to the db registered by the route factories. */
  db?: Knex;
}): Mw {
  const apiKeyMw = createApiKeyMiddleware({ apiKeyRepo: deps.apiKeyRepo });

  return (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer pk_')) {
      deps.jwtMiddleware(req, res, next);
      return;
    }
    void apiKeyMw(req, res, () => {
      const key = (req as Request & { apiKey?: ApiKey }).apiKey;
      if (!key) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.', details: {} } });
        return;
      }
      if (!isApiKeyRouteAllowed(req.method, relativeApiPath(req))) {
        res.status(403).json({
          error: {
            code: 'INSUFFICIENT_SCOPE',
            message: 'API keys cannot call this endpoint.',
            details: {},
          },
        });
        return;
      }
      const needed = SAFE_METHODS.has(req.method) ? 'feedback:read' : 'feedback:write';
      if (!key.scopes.includes(needed)) {
        res.status(403).json({
          error: { code: 'INSUFFICIENT_SCOPE', message: `This API key lacks the '${needed}' scope.`, details: { required: needed } },
        });
        return;
      }
      // The key acts as its creator: if that user has left the org the key is dead.
      const db = deps.db ?? getRegisteredSessionDb();
      if (!db) {
        next();
        return;
      }
      void db('memberships')
        .where({ org_id: key.orgId, user_id: key.createdBy })
        .first('user_id')
        .then((row: unknown) => {
          if (!row) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.', details: {} } });
            return;
          }
          next();
        }, next);
    }).catch(next);
  };
}
