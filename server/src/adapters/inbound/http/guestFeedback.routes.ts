// Guest feedback route — public (no auth), rate-limited (Mission A7).
//
// Allows guests to submit feedback on shared project links without
// registration. Hardening applied in Mission A7:
//
//   1. Redis fail-closed rate limit + per-link daily quota, keyed by
//      `linkId` (reuses `createWidgetRateLimit` with a pluggable identity
//      resolver). A Redis outage REJECTS rather than unlocking the public
//      surface.
//   2. A missing link and a link with feedback disabled return BYTE-FOR-BYTE
//      IDENTICAL responses (same 404 status + body) so the endpoint cannot
//      be used as an enumeration oracle to distinguish "no such link" from
//      "link exists but feedback is off".
//   3. `X-Robots-Tag: noindex` on every shared/guest response so crawlers
//      never index a shared surface.
//   4. Guest-authored annotations are flagged (`isGuest`, `guestName`,
//      `guestEmail`); the dashboard renders an "Unverified guest" badge.
//   5. All error responses use the canonical
//      `{ error: { code, message, details } }` envelope via `errors.ts`
//      helpers — no bare-string `error:` and no flat top-level `issues`.
//
// NOTE (Mission A7.5 — guest reply tokens): the codebase has no concept of
// scoped/expiring guest reply tokens today, so none is invented here. See
// the summary for the explicit note.
//
// NOTE (Mission A7.6 — guest confirmation emails): no guest confirmation
// email is sent today. If one is introduced it MUST be enqueued through the
// durable notification queue (never direct-sent); this route therefore
// never takes a `Mailer` dependency.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isHttpUrl, paramString, sendZodFailure } from './errors.js';
import {
  createWidgetRateLimit,
  type WidgetRateLimitRedis,
} from '../../../middleware/widgetRateLimit.js';
import {
  SHARED_LINK_ACCESS_COOKIE,
  createSharedLinkAccessSigner,
  readCookie,
  type SharedLinkAccessSigner,
} from './sharedLinkAccess.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { SharedLinkRepo } from '../../../domain/sharedLink/ports/SharedLinkRepo.js';
import type { PageRepo } from '../../../domain/project/ports/PageRepo.js';
import type { CreateGuestAnnotation } from '../../../domain/annotation/usecases/createAnnotation.js';

export interface GuestFeedbackRouteDeps {
  /** Kept for deps-shape compatibility; writes go through createGuestAnnotation. */
  annotationRepo?: AnnotationRepo;
  sharedLinkRepo: SharedLinkRepo;
  pageRepo?: PageRepo;
  /** Transactional guest create (page resolve + atomic pin + insert + broadcast). */
  createGuestAnnotation: Pick<CreateGuestAnnotation, 'execute'>;
  /**
   * Redis client for the fail-closed per-link limiter; omit (tests) to fall
   * back to the in-memory store. Mirrors the widget route wiring.
   */
  rateLimitRedis?: WidgetRateLimitRedis;
  /**
   * Secret the shared-link access grants are signed with. Required to accept
   * feedback on password-protected links (PP-14); without it such links answer
   * as unavailable (fail closed).
   */
  accessSecret?: string;
  /** Test seam: replace the grant signer. */
  accessSigner?: SharedLinkAccessSigner;
  /**
   * Max guest submissions per link per UTC day (daily quota). Defaults to
   * 50; set `null` to disable the daily cap.
   */
  dailyQuota?: number | null;
  /** Burst window length in ms (default 1h). */
  windowMs?: number;
  /** Max submissions per burst window (default 5). */
  max?: number;
}

/** Default per-link daily quota for guest feedback. */
export const GUEST_FEEDBACK_DAILY_QUOTA = 50;
/** Default burst window: 5 submissions per hour per link. */
export const GUEST_FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
export const GUEST_FEEDBACK_MAX_PER_WINDOW = 5;

const GuestFeedbackBodySchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  description: z.string().min(1).max(5000),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  pageUrl: z.string().url().max(2000).refine(isHttpUrl, 'pageUrl must be an http(s) URL.'),
});

/**
 * Attach `X-Robots-Tag: noindex` to every response the shared/guest surface
 * emits (Mission A7.3). Mounted as the first middleware on the router.
 */
function noindex(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
}

/**
 * The single canonical "this link cannot accept feedback" response. Used for
 * BOTH a missing link and a feedback-disabled link so the two are
 * indistinguishable from the outside (Mission A7.3 — kill the enumeration
 * oracle). Returns the same 404 status and body in either case.
 */
function sendLinkUnavailable(res: Response): Response {
  return res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Shared link not found.',
      details: {},
    },
  });
}

export function createGuestFeedbackRoutes(deps: GuestFeedbackRouteDeps): Router {
  const router = Router();
  const { sharedLinkRepo, createGuestAnnotation } = deps;

  router.use(noindex);

  const signer = deps.accessSigner ?? (deps.accessSecret ? createSharedLinkAccessSigner(deps.accessSecret) : null);

  const dailyQuota =
    deps.dailyQuota === undefined ? GUEST_FEEDBACK_DAILY_QUOTA : deps.dailyQuota;

  // Per-link Redis fail-closed limiter + daily quota, keyed by linkId
  // (Mission A7.1). Reuses the widget limiter via its pluggable identity
  // resolver; a dedicated `keyPrefix` namespaces the counters away from the
  // widget-key counters so the two public surfaces never collide.
  const guestFeedbackLimiter = createWidgetRateLimit(
    {
      getIdentity: (req) => {
        const linkId = paramString(req.params.linkId);
        if (!linkId) return undefined;
        return { id: linkId, dailyQuota };
      },
    },
    {
      keyPrefix: 'grl',
      windowMs: deps.windowMs ?? GUEST_FEEDBACK_WINDOW_MS,
      max: deps.max ?? GUEST_FEEDBACK_MAX_PER_WINDOW,
      failMode: 'closed',
      ...(deps.rateLimitRedis
        ? { store: 'redis' as const, redis: deps.rateLimitRedis }
        : { store: 'memory' as const }),
    },
  );

  // POST /api/v1/shared/:linkId/feedback — public guest feedback submission.
  // The limiter runs AFTER the linkId param is available (it keys on it) but
  // BEFORE any DB lookup, so a flood never reaches the repo.
  router.post(
    '/:linkId/feedback',
    guestFeedbackLimiter,
    async (req: Request, res: Response) => {
      const linkId = paramString(req.params.linkId);
      if (!linkId) {
        // A blank param is equivalent to "no such link" — identical response.
        return sendLinkUnavailable(res);
      }

      const link = await sharedLinkRepo.findById(linkId);

      // Enumeration-oracle kill (Mission A7.3): a missing link and a
      // feedback-disabled link are INDISTINGUISHABLE — same status + body.
      if (!link || !link.allowFeedback) {
        return sendLinkUnavailable(res);
      }

      // PP-14: a password-protected link needs the signed access grant that
      // POST /verify issues (same cookie the read endpoint requires); the link id
      // alone must not bypass the password.
      if (link.passwordHash) {
        const grant = readCookie(req, SHARED_LINK_ACCESS_COOKIE);
        if (!signer || !signer.verify(grant, link.id, link.passwordHash)) {
          return res.status(401).json({
            error: {
              code: 'SHARED_ACCESS_REQUIRED',
              message: 'Password verification is required to leave feedback on this link.',
              details: {},
            },
          });
        }
      }

      // Validate body — canonical envelope via the shared helper (A7.7).
      const parsed = GuestFeedbackBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendZodFailure(
          res,
          'Invalid feedback payload.',
          parsed.error.flatten(),
        );
      }

      const { name, email, description, severity, pageUrl } = parsed.data;

      // Page resolve/create, atomic pin allocation, insert (author_id NULL,
      // is_guest) and the realtime broadcast all run in one transaction.
      const result = await createGuestAnnotation.execute({
        projectId: link.projectId,
        pageUrl,
        type: 'note',
        severity: severity ?? 'informational',
        body: description,
        guest: { name, email: email ?? null },
        target: {
          cssSelector: '',
          xpath: '',
          pageX: 0,
          pageY: 0,
          tagName: 'body',
          textSnippet: '',
        },
        environment: {
          browserFamily: 'unknown',
          browserVersion: null,
          osFamily: 'unknown',
          osVersion: null,
          deviceType: 'desktop',
          userAgentRaw: req.headers['user-agent'] || '',
        },
      });
      if (!result.ok) {
        // Linked project was deleted — indistinguishable from a dead link.
        return sendLinkUnavailable(res);
      }
      const annotation = result.value.annotation;

      res.status(201).json({
        data: {
          id: annotation.id,
          projectId: annotation.projectId,
          description: annotation.body,
          severity: annotation.severity,
          guestName: annotation.guestName,
          isGuest: annotation.isGuest,
          createdAt: annotation.createdAt,
        },
      });
    },
  );

  return router;
}
