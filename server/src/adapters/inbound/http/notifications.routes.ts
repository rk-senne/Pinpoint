import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ListUserNotifications } from '../../../domain/notification/usecases/userNotifications.js';
import type { MarkNotificationRead } from '../../../domain/notification/usecases/userNotifications.js';
import type { UserNotificationRepo } from '../../../domain/notification/ports/UserNotificationRepo.js';
import { sendZodFailure } from './errors.js';

export interface NotificationsRouteDeps {
  listUserNotifications: ListUserNotifications;
  markNotificationRead: MarkNotificationRead;
  userNotificationRepo: UserNotificationRepo;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PreferencesSchema = z.object({
  mention: z.boolean().optional(),
  commentOnOwn: z.boolean().optional(),
  statusChange: z.boolean().optional(),
  projectActivity: z.boolean().optional(),
});

export function createNotificationsRoutes(deps: NotificationsRouteDeps): Router {
  const { listUserNotifications, markNotificationRead, userNotificationRepo, authMiddleware } = deps;

  const router = Router();
  router.use(authMiddleware);

  router.get('/', async (req: Request, res: Response) => {
    const parsed = PaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid pagination.', parsed.error.flatten());
      return;
    }
    const result = await listUserNotifications.execute({
      userId: req.user!.userId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    if (!result.ok) { res.status(500).json({ error: 'Internal error' }); return; }
    res.json(result.value);
  });

  router.patch('/:id/read', async (req: Request, res: Response) => {
    await markNotificationRead.execute({ id: req.params.id, userId: req.user!.userId });
    res.status(204).end();
  });

  router.post('/read-all', async (req: Request, res: Response) => {
    await markNotificationRead.execute({ userId: req.user!.userId, all: true });
    res.status(204).end();
  });

  router.get('/preferences', async (req: Request, res: Response) => {
    const prefs = await userNotificationRepo.getPreferences(req.user!.userId, req.user!.orgId);
    res.json({ preferences: prefs ?? { mention: true, commentOnOwn: true, statusChange: true, projectActivity: false } });
  });

  router.put('/preferences', async (req: Request, res: Response) => {
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid preferences.', parsed.error.flatten());
      return;
    }
    const existing = await userNotificationRepo.getPreferences(req.user!.userId, req.user!.orgId);
    const merged = {
      userId: req.user!.userId,
      orgId: req.user!.orgId,
      mention: parsed.data.mention ?? existing?.mention ?? true,
      commentOnOwn: parsed.data.commentOnOwn ?? existing?.commentOnOwn ?? true,
      statusChange: parsed.data.statusChange ?? existing?.statusChange ?? true,
      projectActivity: parsed.data.projectActivity ?? existing?.projectActivity ?? false,
    };
    await userNotificationRepo.upsertPreferences(merged);
    res.json({ preferences: merged });
  });

  return router;
}
