// Inbound HTTP adapter — privacy / data-subject-rights routes.
//
// Mounted at `/api/v1/privacy` (see docs/legal/*):
//
//   GET    /export       the caller's personal data + content they authored,
//                        across every org they belong to (GDPR Art. 15/20,
//                        POPIA s.23, CCPA right to know). Streamed JSON.
//   GET    /org-export   the caller's current org's data (owner/admin only).
//                        Streamed JSON. Lets an org take its data out (Art. 20).
//   DELETE /account      erase the caller's account (Art. 17, POPIA s.24).
//                        Password re-authentication required.
//   DELETE /org          erase the whole current org (owner only). Password +
//                        the org name typed back.
//
// Both exports are audit-logged, size-capped (the archive is flagged
// `"truncated": true` when the cap is hit) and sent `Cache-Control: no-store`.
// The routes use the plain auth middleware (NOT the viewer write-guard): a
// read-only member must still be able to erase their own account.

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';

import type { EraseAccount } from '../../../domain/privacy/usecases/eraseAccount.js';
import type { EraseOrg } from '../../../domain/privacy/usecases/eraseOrg.js';
import type { PrivacyRepo } from '../../../domain/privacy/ports/PrivacyRepo.js';
import { JsonArchiveWriter } from '../../../domain/privacy/JsonArchiveWriter.js';
import { buildClearCookies } from '../../../middleware/sessionCookies.js';
import { recordAudit } from './auditLog.routes.js';
import { sendDomainError, sendZodFailure } from './errors.js';

export const USER_EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const ORG_EXPORT_MAX_BYTES = 250 * 1024 * 1024;
/** Failed re-authentications allowed per user per window before 429. */
const REAUTH_MAX_FAILURES = 5;
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

export interface PrivacyRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
  repo: PrivacyRepo;
  eraseAccount: Pick<EraseAccount, 'execute'>;
  eraseOrg: Pick<EraseOrg, 'execute'>;
  /** Drop the `Secure` cookie attribute (plain-HTTP loopback stack). */
  cookieInsecure?: boolean;
  userExportMaxBytes?: number;
  orgExportMaxBytes?: number;
  now?: () => number;
}

const AccountBodySchema = z.object({
  password: z.string().max(256).optional(),
  confirmEmail: z.string().max(254).optional(),
});

const OrgBodySchema = AccountBodySchema.extend({
  confirmName: z.string().min(1).max(200),
});

export function createPrivacyRoutes(deps: PrivacyRouteDeps): Router {
  const { authMiddleware, db, repo, eraseAccount, eraseOrg } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();
  router.use(authMiddleware);

  // Per-user throttle on FAILED re-authentication (password guessing through
  // a stolen session). In-memory: per instance, resets on restart — the
  // account-level login limiter remains the primary defence.
  const failures = new Map<string, { count: number; resetAt: number }>();
  const throttled = (userId: string): boolean => {
    const f = failures.get(userId);
    if (!f) return false;
    if (f.resetAt <= now()) {
      failures.delete(userId);
      return false;
    }
    return f.count >= REAUTH_MAX_FAILURES;
  };
  const noteFailure = (userId: string): void => {
    const f = failures.get(userId);
    if (!f || f.resetAt <= now()) failures.set(userId, { count: 1, resetAt: now() + REAUTH_WINDOW_MS });
    else f.count += 1;
  };
  const tooMany = (res: Response): void => {
    res.status(429).json({
      error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed confirmations. Try again later.' },
    });
  };

  /** Stream an archive: headers, `meta`, body via `fill`, close. */
  async function streamArchive(
    res: Response,
    filename: string,
    maxBytes: number,
    meta: Record<string, unknown>,
    fill: (w: JsonArchiveWriter) => Promise<void>,
  ): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    const writer = new JsonArchiveWriter(async (chunk) => {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', () => resolve()));
      }
    }, maxBytes);
    try {
      await writer.begin(meta);
      await fill(writer);
      await writer.end();
      res.end();
    } catch {
      // Headers are already sent: the only honest signal is to abort the body
      // so the client sees a failed (not a silently short) download.
      res.destroy();
    }
  }

  // GET /export -----------------------------------------------------------
  router.get('/export', async (req: Request, res: Response) => {
    const user = req.user!;
    await recordAudit(db, {
      orgId: user.orgId,
      actorId: user.userId,
      action: 'privacy.user_export',
      resourceType: 'user',
      resourceId: user.userId,
      request: req,
    });
    const stamp = new Date(now()).toISOString();
    await streamArchive(
      res,
      `pinpoint-my-data-${stamp.slice(0, 10)}.json`,
      deps.userExportMaxBytes ?? USER_EXPORT_MAX_BYTES,
      { kind: 'user-export', generatedAt: stamp, userId: user.userId, format: 1 },
      (w) => repo.streamUserExport(user.userId, w),
    );
  });

  // GET /org-export -------------------------------------------------------
  router.get('/org-export', async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.role !== 'owner' && user.role !== 'admin') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only organisation owners and admins can export organisation data.' } });
      return;
    }
    await recordAudit(db, {
      orgId: user.orgId,
      actorId: user.userId,
      action: 'privacy.org_export',
      resourceType: 'organization',
      resourceId: user.orgId,
      request: req,
    });
    const stamp = new Date(now()).toISOString();
    await streamArchive(
      res,
      `pinpoint-org-data-${stamp.slice(0, 10)}.json`,
      deps.orgExportMaxBytes ?? ORG_EXPORT_MAX_BYTES,
      { kind: 'org-export', generatedAt: stamp, orgId: user.orgId, format: 1 },
      (w) => repo.streamOrgExport(user.orgId, w),
    );
  });

  // DELETE /account -------------------------------------------------------
  router.delete('/account', async (req: Request, res: Response) => {
    const user = req.user!;
    const parsed = AccountBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid request.', parsed.error.flatten());
      return;
    }
    if (throttled(user.userId)) return tooMany(res);
    const result = await eraseAccount.execute({ userId: user.userId, ...parsed.data });
    if (!result.ok) {
      if (result.error.code === 'INVALID_PASSWORD' || result.error.code === 'CONFIRMATION_MISMATCH') noteFailure(user.userId);
      sendDomainError(res, result.error);
      return;
    }
    for (const c of buildClearCookies(deps.cookieInsecure ?? false)) res.append('Set-Cookie', c);
    res.status(200).json({ deleted: true, ...result.value });
  });

  // DELETE /org -----------------------------------------------------------
  router.delete('/org', async (req: Request, res: Response) => {
    const user = req.user!;
    // Role first (before body validation): only an owner may even attempt this,
    // and a non-owner must see the same 403 FORBIDDEN as every other
    // role-guarded mutation (see viewerWriteGuard.test.ts).
    if (user.role !== 'owner') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only an organisation owner can delete the organisation.' } });
      return;
    }
    const parsed = OrgBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid request.', parsed.error.flatten());
      return;
    }
    if (throttled(user.userId)) return tooMany(res);
    const result = await eraseOrg.execute({
      orgId: user.orgId,
      actorId: user.userId,
      actorRole: user.role,
      ...parsed.data,
    });
    if (!result.ok) {
      if (result.error.code === 'INVALID_PASSWORD' || result.error.code === 'CONFIRMATION_MISMATCH') noteFailure(user.userId);
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ deleted: true, ...result.value });
  });

  return router;
}
