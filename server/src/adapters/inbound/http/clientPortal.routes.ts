import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { sendZodFailure } from './errors.js';

export interface ClientPortalRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CreatePortalSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  welcomeMessage: z.string().optional(),
  brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  logoUrl: z.string().url().optional(),
  allowNewFeedback: z.boolean().optional(),
  requireEmail: z.boolean().optional(),
});

const PortalAccessSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export function createClientPortalRoutes(deps: ClientPortalRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();

  // === Admin routes (auth required) ===

  // POST /api/v1/portals — create portal
  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreatePortalSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid portal config.', parsed.error.flatten()); return; }

    const [portal] = await db('client_portals').insert({
      org_id: req.user!.orgId,
      project_id: parsed.data.projectId,
      slug: parsed.data.slug,
      title: parsed.data.title,
      welcome_message: parsed.data.welcomeMessage,
      brand_color: parsed.data.brandColor ?? '#4f46e5',
      logo_url: parsed.data.logoUrl,
      allow_new_feedback: parsed.data.allowNewFeedback ?? true,
      require_email: parsed.data.requireEmail ?? true,
    }).returning('*');
    res.status(201).json({ portal });
  });

  // GET /api/v1/portals — list org's portals
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const portals = await db('client_portals').where('org_id', req.user!.orgId).orderBy('created_at', 'desc');
    res.json({ portals });
  });

  // DELETE /api/v1/portals/:id
  router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
    const deleted = await db('client_portals').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    if (!deleted) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }
    res.status(204).end();
  });

  // === Guest routes (no auth — token-based) ===

  // GET /portal/:slug — public portal info
  router.get('/:slug/info', async (req: Request, res: Response) => {
    const portal = await db('client_portals').where({ slug: req.params.slug, active: true }).first();
    if (!portal) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }
    const { id, title, welcome_message, brand_color, logo_url, allow_new_feedback, require_email } = portal;
    res.json({ portal: { id, title, welcomeMessage: welcome_message, brandColor: brand_color, logoUrl: logo_url, allowNewFeedback: allow_new_feedback, requireEmail: require_email } });
  });

  // POST /portal/:slug/access — request guest access token
  router.post('/:slug/access', async (req: Request, res: Response) => {
    const portal = await db('client_portals').where({ slug: req.params.slug, active: true }).first();
    if (!portal) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }

    const parsed = PortalAccessSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid access request.', parsed.error.flatten()); return; }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await db('portal_sessions').insert({
      portal_id: portal.id,
      email: parsed.data.email,
      name: parsed.data.name,
      token,
      expires_at: expiresAt,
    });

    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  });

  // GET /portal/:slug/feedback — view feedback (token required)
  router.get('/:slug/feedback', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }); return; }

    const session = await db('portal_sessions').where({ token }).where('expires_at', '>', new Date()).first();
    if (!session) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }); return; }

    const portal = await db('client_portals').where({ id: session.portal_id, active: true }).first();
    if (!portal) { res.status(404).end(); return; }

    const annotations = await db('annotations')
      .where({ project_id: portal.project_id, org_id: portal.org_id })
      .whereIn('status', ['active', 'resolved'])
      .orderBy('created_at', 'desc')
      .limit(100);

    res.json({ feedback: annotations });
  });

  return router;
}
