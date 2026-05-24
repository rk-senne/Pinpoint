// Inbound HTTP adapter — user profile routes (Phase 1.5 / Wave 2 follow-up).
//
// Mounted at `/api/v1/users`. Routes:
//
//   GET  /me                — return the authenticated user's profile.
//   PUT  /me                — patch name / email / avatarUrl.
//   PUT  /me/notifications  — patch the notification preference toggles.
//
// All three routes require auth. The `User` shape returned by the use
// cases never carries `passwordHash` (UserRepo's safe projection), so
// secrets cannot leak through the payload — but we still serialise
// field-by-field so the wire format stays explicit.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { GetCurrentUser } from '../../../domain/user/usecases/getCurrentUser.js';
import type { UpdateProfile } from '../../../domain/user/usecases/updateProfile.js';
import type { UpdateNotificationPreferences } from '../../../domain/user/usecases/updateNotificationPreferences.js';
import type { NotificationPreferences, User } from '../../../domain/user/User.js';
import { sendDomainError, sendZodFailure } from './errors.js';

export interface UsersRouteDeps {
  getCurrentUser: GetCurrentUser;
  updateProfile: UpdateProfile;
  updateNotificationPreferences: UpdateNotificationPreferences;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

// --- Zod schemas ----------------------------------------------------------

// `unknown()` (rather than the typed leaves) lets us forward the raw
// value to the use case where the legacy field-by-field validation
// lives. Zod is only here to make sure the body is a JSON object.
const UpdateProfileBodySchema = z
  .object({
    name: z.unknown().optional(),
    email: z.unknown().optional(),
    avatarUrl: z.unknown().optional(),
  })
  .passthrough();

const UpdateNotificationsBodySchema = z
  .object({
    newAnnotation: z.unknown().optional(),
    newComment: z.unknown().optional(),
    promotedToOwner: z.unknown().optional(),
    projectDeleted: z.unknown().optional(),
  })
  .passthrough();

// --- Response shaping ------------------------------------------------------

/**
 * Render the safe `User` projection on the wire. `avatarUrl` is
 * normalised to `null` (rather than `undefined`) to match the legacy
 * envelope so the dashboard's input binding (`user.avatarUrl ?? ''`)
 * keeps working unchanged.
 */
function renderUser(user: User): {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  notificationPreferences: User['notificationPreferences'];
  createdAt: string;
} {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    notificationPreferences: user.notificationPreferences,
    createdAt: user.createdAt,
  };
}

// --- Router factory --------------------------------------------------------

export function createUsersRoutes(deps: UsersRouteDeps): Router {
  const {
    getCurrentUser,
    updateProfile,
    updateNotificationPreferences,
    authMiddleware,
  } = deps;

  const router = Router();
  router.use(authMiddleware);

  // GET /me ---------------------------------------------------------------
  router.get('/me', async (req: Request, res: Response) => {
    const result = await getCurrentUser.execute({
      userId: req.user!.userId,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ user: renderUser(result.value.user) });
  });

  // PUT /me ---------------------------------------------------------------
  router.put('/me', async (req: Request, res: Response) => {
    const parsed = UpdateProfileBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid profile payload.', parsed.error.flatten());
      return;
    }

    const input: {
      userId: string;
      name?: string;
      email?: string;
      avatarUrl?: string | null;
    } = { userId: req.user!.userId };
    if (parsed.data.name !== undefined) input.name = parsed.data.name as string;
    if (parsed.data.email !== undefined) input.email = parsed.data.email as string;
    if (parsed.data.avatarUrl !== undefined) {
      input.avatarUrl = parsed.data.avatarUrl as string | null;
    }

    const result = await updateProfile.execute(input);
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      message: 'Profile updated successfully.',
      user: renderUser(result.value.user),
    });
  });

  // PUT /me/notifications -------------------------------------------------
  router.put('/me/notifications', async (req: Request, res: Response) => {
    const parsed = UpdateNotificationsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(
        res,
        'Invalid notification preferences payload.',
        parsed.error.flatten(),
      );
      return;
    }

    const result = await updateNotificationPreferences.execute({
      userId: req.user!.userId,
      preferences: parsed.data as Partial<NotificationPreferences>,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      message: 'Notification preferences updated successfully.',
      notificationPreferences: result.value.notificationPreferences,
    });
  });

  return router;
}
