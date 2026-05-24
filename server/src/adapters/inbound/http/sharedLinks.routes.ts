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
import type { VerifyLinkPassword } from '../../../domain/sharedLink/usecases/verifyLinkPassword.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface SharedLinkRouteDeps {
  createSharedLink: CreateSharedLink;
  verifyLinkPassword: VerifyLinkPassword;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

export interface SharedLinkRouterPair {
  /** Mounted at `/api/v1/projects/:id/share`. */
  shareRouter: Router;
  /** Mounted at `/api/v1/shared`. */
  verifyRouter: Router;
}

const SharePostBodySchema = z.object({
  password: z.string().nullable().optional(),
});

const VerifyBodySchema = z
  .object({
    password: z.string().optional(),
  })
  .partial();

export function createSharedLinkRoutes(
  deps: SharedLinkRouteDeps,
): SharedLinkRouterPair {
  const { createSharedLink, verifyLinkPassword, authMiddleware } = deps;

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
        createdAt: link.createdAt,
      },
    });
  });

  // ----- /shared/:linkId/verify (no auth) --------------------------------
  const verifyRouter = Router();

  verifyRouter.post('/:linkId/verify', async (req: Request, res: Response) => {
    const parsed = VerifyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid verify payload.', parsed.error.flatten());
      return;
    }
    const linkId = paramString(req.params.linkId);
    const result = await verifyLinkPassword.execute({
      linkId,
      ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {}),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      access: true,
      projectId: result.value.projectId,
    });
  });

  return { shareRouter, verifyRouter };
}
