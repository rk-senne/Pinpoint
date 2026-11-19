import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { WEBHOOK_EVENTS } from '../../../domain/webhook/Webhook.js';
import type { RegisterWebhook, DeleteWebhook } from '../../../domain/webhook/usecases/webhooks.js';
import type { WebhookRepo } from '../../../domain/webhook/ports/WebhookRepo.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';
import { recordAudit } from './auditLog.routes.js';
import { registerSessionDb, requireOrgAdmin } from './access.js';
import { assertPublicUrl as defaultAssertPublicUrl } from '../../../services/egressGuard.js';

export interface WebhookRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  registerWebhook: RegisterWebhook;
  deleteWebhook: DeleteWebhook;
  webhookRepo: WebhookRepo;
  db: Knex;
  /**
   * SSRF guard applied to a changed URL on PATCH (same guard as create).
   * Defaults to the shared egress guard; plain http is allowed only in
   * development/test.
   */
  assertPublicUrl?: (url: string) => Promise<unknown>;
}

const CreateWebhookSchema = z.object({
  url: z.string().max(2048).url(),
  events: z.array(z.string()).min(1),
});

const UpdateWebhookSchema = z.object({
  url: z.string().max(2048).url().optional(),
  events: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export function createWebhookRoutes(deps: WebhookRouteDeps): Router {
  const { authMiddleware, registerWebhook, deleteWebhook, webhookRepo, db } = deps;
  const router = Router();
  router.use(authMiddleware);
  registerSessionDb(db);
  const assertPublicUrl =
    deps.assertPublicUrl ??
    ((url: string) =>
      defaultAssertPublicUrl(url, {
        allowHttp: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
      }));

  // POST /api/v1/webhooks
  router.post('/', requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = CreateWebhookSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid webhook.', parsed.error.flatten()); return; }

    const result = await registerWebhook.execute({ orgId: req.user!.orgId, ...parsed.data });
    if (!result.ok) { sendDomainError(res, result.error); return; }
    await recordAudit(db, {
      request: req,
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: result.value.endpoint.id,
      metadata: { url: parsed.data.url, events: parsed.data.events },
    });
    // The plaintext `whsec_` signing secret is returned exactly ONCE here, on
    // create. List (GET /) and update (PATCH) responses strip it — the server
    // never exposes it again (A5b).
    res.status(201).json({ webhook: result.value.endpoint });
  });

  // GET /api/v1/webhooks
  router.get('/', requireOrgAdmin, async (req: Request, res: Response) => {
    const orgId = req.user!.orgId;

    const parsed = PaginationParamsSchema.safeParse(req.query);
    const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 25 };
    const offset = (page - 1) * pageSize;

    const [{ count: total }] = await db('webhook_endpoints')
      .where('org_id', orgId)
      .count('* as count');

    const rows = await db('webhook_endpoints')
      .where('org_id', orgId)
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset(offset);

    const endpoints = rows.map((r: any) => ({
      id: r.id,
      orgId: r.org_id,
      url: r.url,
      events: typeof r.events === 'string' ? JSON.parse(r.events) : r.events,
      active: r.active,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    }));

    res.json({
      data: endpoints,
      pagination: paginationMeta(Number(total), page, pageSize),
    });
  });

  // PATCH /api/v1/webhooks/:id
  router.patch('/:id', requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = UpdateWebhookSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid update.', parsed.error.flatten()); return; }

    if (parsed.data.events) {
      const invalid = parsed.data.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
      if (invalid.length > 0) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `Invalid events: ${invalid.join(', ')}` } });
        return;
      }
    }

    // A changed URL must pass the same SSRF egress guard as create.
    if (parsed.data.url !== undefined) {
      try {
        await assertPublicUrl(parsed.data.url);
      } catch (e) {
        const reason = e instanceof Error && e.name === 'EgressBlockedError' ? `: ${e.message}` : '';
        res.status(400).json({ error: { code: 'VALIDATION', message: `Webhook URL rejected${reason}` } });
        return;
      }
    }

    const updated = await webhookRepo.update(paramString(req.params.id), req.user!.orgId, parsed.data);
    if (!updated) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } }); return; }
    const { secret, ...rest } = updated;
    res.json({ webhook: rest });
  });

  // DELETE /api/v1/webhooks/:id
  router.delete('/:id', requireOrgAdmin, async (req: Request, res: Response) => {
    const result = await deleteWebhook.execute(paramString(req.params.id), req.user!.orgId);
    if (!result.ok) { sendDomainError(res, result.error); return; }
    await recordAudit(db, {
      request: req,
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'webhook.deleted',
      resourceType: 'webhook',
      resourceId: paramString(req.params.id),
    });
    res.status(204).end();
  });

  // GET /api/v1/webhooks/:id/deliveries
  router.get('/:id/deliveries', requireOrgAdmin, async (req: Request, res: Response) => {
    const endpoint = await webhookRepo.findById(paramString(req.params.id), req.user!.orgId);
    if (!endpoint) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } }); return; }

    const parsed = PaginationParamsSchema.safeParse(req.query);
    const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 25 };
    const offset = (page - 1) * pageSize;

    const total = await webhookRepo.countDeliveries(paramString(req.params.id));
    const deliveries = await webhookRepo.listDeliveries(paramString(req.params.id), pageSize, offset);

    res.json({
      data: deliveries,
      pagination: paginationMeta(total, page, pageSize),
    });
  });

  // GET /api/v1/webhooks/events — list available event types
  router.get('/events', (_req: Request, res: Response) => {
    res.json({ events: WEBHOOK_EVENTS });
  });

  return router;
}
