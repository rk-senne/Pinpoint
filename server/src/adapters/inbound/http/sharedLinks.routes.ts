// Inbound HTTP adapter — shared link routes (Phase 1.5 / task 4.9.1).
//
// Two routers are exported, mirroring the legacy split: the
// owner-protected `share` router (mounted at
// `/api/v1/projects/:id/share`) and the public `verify` router
// (mounted at `/api/v1/shared`). The verify path additionally exposes
// a `GET /:linkId` lookup that resolves a project + open-link state.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { CreateSharedLink } from '../../../domain/sharedLink/usecases/createSharedLink.js';
import {
  InvalidPassword,
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  SharedLinkLocked,
  type VerifyLinkPassword,
} from '../../../domain/sharedLink/usecases/verifyLinkPassword.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { PageRepo } from '../../../domain/project/ports/PageRepo.js';
import type { SharedLinkRepo } from '../../../domain/sharedLink/ports/SharedLinkRepo.js';
import { sendDomainError, sendZodFailure, sendError, paramString } from './errors.js';
import {
  SHARED_LINK_ACCESS_COOKIE,
  createSharedLinkAccessSigner,
  readCookie,
  setSharedLinkAccessCookie,
  type SharedLinkAccessSigner,
} from './sharedLinkAccess.js';

export interface SharedLinkRouteDeps {
  createSharedLink: CreateSharedLink;
  verifyLinkPassword: VerifyLinkPassword;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Read side for the visitor-facing annotation list. */
  sharedLinkRepo: SharedLinkRepo;
  annotationRepo: AnnotationRepo;
  pageRepo: PageRepo;
  /** Secret the shared-link access grants are signed with (domain-separated). */
  accessSecret: string;
  /** Drop the Secure flag on the grant cookie (plain-HTTP local stacks only). */
  cookieInsecure?: boolean;
  /** Test seam: replace the signer (e.g. to control the clock). */
  accessSigner?: SharedLinkAccessSigner;
}

/** Max annotations returned to a shared-link visitor. */
export const SHARED_ANNOTATIONS_LIMIT = 500;

export interface SharedLinkRouterPair {
  /** Mounted at `/api/v1/projects/:id/share`. */
  shareRouter: Router;
  /** Mounted at `/api/v1/shared`. */
  verifyRouter: Router;
}

const SharePostBodySchema = z.object({
  password: z.string().max(256).nullable().optional(),
  allowFeedback: z.boolean().optional(),
});

const VerifyBodySchema = z
  .object({
    password: z.string().max(256).optional(),
  })
  .partial();

/**
 * PP-14: strict lockout keyed by (link, client IP). Three wrong passwords lock
 * only that visitor's address for 15 minutes; everyone else can still try, so
 * possession of the URL no longer lets a stranger lock out the audience. The
 * per-link global ceiling in the use case remains as a backstop. In-memory
 * (per instance) by design — it is a throttle, not an authorization state.
 */
export function createIpAttemptLimiter(opts: { max: number; lockMs: number; maxEntries?: number; now?: () => number }) {
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? 10_000;
  const state = new Map<string, { failures: number; lockedUntil: number }>();
  const prune = (): void => {
    if (state.size < maxEntries) return;
    const t = now();
    for (const [k, v] of state) if (v.lockedUntil <= t && v.failures === 0) state.delete(k);
    while (state.size >= maxEntries) state.delete(state.keys().next().value as string);
  };
  return {
    /** Seconds the caller must wait, or 0 when allowed. */
    retryAfter(key: string): number {
      const v = state.get(key);
      if (!v || v.lockedUntil <= now()) return 0;
      return Math.ceil((v.lockedUntil - now()) / 1000);
    },
    fail(key: string): number {
      prune();
      const v = state.get(key) ?? { failures: 0, lockedUntil: 0 };
      if (v.lockedUntil <= now() && v.lockedUntil !== 0) { v.failures = 0; v.lockedUntil = 0; }
      v.failures += 1;
      if (v.failures >= opts.max) v.lockedUntil = now() + opts.lockMs;
      state.set(key, v);
      return Math.max(0, opts.max - v.failures);
    },
    reset(key: string): void { state.delete(key); },
  };
}

export function createSharedLinkRoutes(
  deps: SharedLinkRouteDeps,
): SharedLinkRouterPair {
  const { createSharedLink, verifyLinkPassword, authMiddleware, sharedLinkRepo, annotationRepo, pageRepo } = deps;
  const signer = deps.accessSigner ?? createSharedLinkAccessSigner(deps.accessSecret);
  const cookieInsecure = deps.cookieInsecure ?? false;
  const ipLimiter = createIpAttemptLimiter({ max: MAX_FAILED_ATTEMPTS, lockMs: LOCKOUT_MINUTES * 60 * 1000 });

  // ----- /projects/:id/share (auth required) -----------------------------
  const shareRouter = Router({ mergeParams: true });
  shareRouter.use(authMiddleware);

  shareRouter.post('/', async (req: Request, res: Response) => {
    const parsed = SharePostBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid share payload.', parsed.error.flatten());
      return;
    }
    const projectId = paramString((req.params as { id?: string | string[] }).id);
    const passwordValue =
      typeof parsed.data.password === 'string' && parsed.data.password.length > 0
        ? parsed.data.password
        : null;
    const result = await createSharedLink.execute({
      userId: req.user!.userId,
      projectId,
      password: passwordValue,
      allowFeedback: parsed.data.allowFeedback,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const link = result.value;
    res.status(200).json({
      sharedLink: {
        id: link.id,
        projectId: link.projectId,
        hasPassword: !!link.passwordHash,
        allowFeedback: link.allowFeedback,
        createdAt: link.createdAt,
      },
    });
  });

  // ----- /shared/:linkId/verify (no auth) --------------------------------
  const verifyRouter = Router();

  // Mission A7.3: every public shared/guest response carries
  // `X-Robots-Tag: noindex` so crawlers never index a shared surface.
  verifyRouter.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });

  verifyRouter.post('/:linkId/verify', async (req: Request, res: Response) => {
    const parsed = VerifyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid verify payload.', parsed.error.flatten());
      return;
    }
    const linkId = paramString(req.params.linkId);
    const attemptKey = `${linkId}|${req.ip ?? ''}`;
    const wait = ipLimiter.retryAfter(attemptKey);
    if (wait > 0) {
      sendDomainError(res, new SharedLinkLocked(wait, new Date(Date.now() + wait * 1000).toISOString()));
      return;
    }
    const result = await verifyLinkPassword.execute({
      linkId,
      ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {}),
    });
    if (!result.ok) {
      if (result.error instanceof InvalidPassword) {
        const remaining = ipLimiter.fail(attemptKey);
        if (remaining === 0) {
          sendDomainError(res, new SharedLinkLocked(LOCKOUT_MINUTES * 60, new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()));
          return;
        }
        sendDomainError(res, new InvalidPassword(remaining));
        return;
      }
      sendDomainError(res, result.error);
      return;
    }
    ipLimiter.reset(attemptKey);
    // Password-protected links: hand the verified visitor a short-lived,
    // link-bound, HttpOnly grant so they can read the annotations.
    const link = await sharedLinkRepo.findById(linkId);
    if (link?.passwordHash) {
      const { token, maxAgeSeconds } = signer.issue(link.id, link.passwordHash);
      setSharedLinkAccessCookie(res, link.id, token, maxAgeSeconds, cookieInsecure);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      access: true,
      projectId: result.value.projectId,
    });
  });

  // GET /shared/:linkId/annotations — read-only list for visitors. Open
  // links need no grant; password links need the cookie issued by /verify.
  // Returns an explicit allow-list of fields: never user ids, emails, guest
  // emails, diagnostics or session replay.
  verifyRouter.get('/:linkId/annotations', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const linkId = paramString(req.params.linkId);
    const link = linkId ? await sharedLinkRepo.findById(linkId) : null;
    if (!link) {
      sendError(res, 404, 'NOT_FOUND', 'Shared link not found.');
      return;
    }
    if (link.passwordHash) {
      const token = readCookie(req, SHARED_LINK_ACCESS_COOKIE);
      if (!signer.verify(token, link.id, link.passwordHash)) {
        sendError(res, 401, 'SHARED_ACCESS_REQUIRED', 'Password verification is required to view this link.');
        return;
      }
    }
    const [rows, pages] = await Promise.all([
      annotationRepo.listByProject(link.projectId, { limit: SHARED_ANNOTATIONS_LIMIT }),
      pageRepo.listByProject(link.projectId),
    ]);
    const urlByPage = new Map(pages.map((p) => [p.id, p.url]));
    res.status(200).json({
      annotations: rows.map((a) => ({
        pinNumber: a.pinNumber,
        type: a.type,
        severity: a.severity,
        status: a.status,
        body: a.body,
        createdAt: a.createdAt,
        pageUrl: urlByPage.get(a.pageId) ?? null,
      })),
    });
  });

  return { shareRouter, verifyRouter };
}
