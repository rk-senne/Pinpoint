import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '../../../domain/webhook/Webhook.js';
import type { RegisterWebhook, DeleteWebhook } from '../../../domain/webhook/usecases/webhooks.js';
import type { WebhookRepo } from '../../../domain/webhook/ports/WebhookRepo.js';
import { sendDomainError, sendZodFailure } from './errors.js';

export interface WebhookRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  registerWebhook: RegisterWebhook;
  deleteWebhook: DeleteWebhook;
  webhookRepo: WebhookRepo;
}

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export function createWebhookRoutes(deps: WebhookRouteDeps): Router {
  const { authMiddleware, registerWebhook, deleteWebhook, webhookRepo } = deps;
  const router = Router();
  router.use(authMiddleware);

  // POST /api/v1/webhooks
  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateWebhookSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid webhook.', parsed.error.flatten()); return; }

    const result = await registerWebhook.execute({ orgId: req.user!.orgId, ...parsed.data });
    if (!result.ok) { sendDomainError(res, result.error); return; }
    res.status(201).json({ webhook: result.value.endpoint });
  });

  // GET /api/v1/webhooks
  router.get('/', async (req: Request, res: Response) => {
    const endpoints = await webhookRepo.listByOrg(req.user!.orgId);
    // Strip secrets from listing
    res.json({ webhooks: endpoints.map(({ secret, ...rest }) => rest) });
  });

  // PATCH /api/v1/webhooks/:id
  router.patch('/:id', async (req: Request, res: Response) => {
    const parsed = UpdateWebhookSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid update.', parsed.error.flatten()); return; }

    if (parsed.data.events) {
      const invalid = parsed.data.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
      if (invalid.length > 0) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `Invalid events: ${invalid.join(', ')}` } });
        return;
      }
    }

    const updated = await webhookRepo.update(req.params.id, req.user!.orgId, parsed.data);
    if (!updated) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } }); return; }
    const { secret, ...rest } = updated;
    res.json({ webhook: rest });
  });

  // DELETE /api/v1/webhooks/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    const result = await deleteWebhook.execute(req.params.id, req.user!.orgId);
    if (!result.ok) { sendDomainError(res, result.error); return; }
    res.status(204).end();
  });

  // GET /api/v1/webhooks/:id/deliveries
  router.get('/:id/deliveries', async (req: Request, res: Response) => {
    const endpoint = await webhookRepo.findById(req.params.id, req.user!.orgId);
    if (!endpoint) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } }); return; }
    const deliveries = await webhookRepo.listDeliveries(req.params.id, 50);
    res.json({ deliveries });
  });

  // GET /api/v1/webhooks/events — list available event types
  router.get('/events', (_req: Request, res: Response) => {
    res.json({ events: WEBHOOK_EVENTS });
  });

  return router;
}
