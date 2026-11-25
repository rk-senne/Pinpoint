import { systemScope } from '../../../infrastructure/tenantContext.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Knex } from 'knex';
import type { Mailer } from '../../../domain/notification/ports/Mailer.js';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { sendZodFailure } from './errors.js';
import { findAccessibleProject, isUuid, registerSessionDb, requireOrgAdmin } from './access.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Neutral answer for every access request, whether or not an email is sent. */
const ACCESS_REQUEST_MESSAGE = "If that email is on the portal you'll receive a link.";

/** Session lifetime of an emailed portal link. */
const PORTAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ClientPortalRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
  /** Delivers the magic link. Without it no access link can be issued. */
  mailer?: Mailer;
  /** Dashboard base URL used to build the emailed link. */
  appUrl?: string;
  /** Max access-link requests per portal+IP per window (default 5 / 15 min). */
  accessRateLimit?: { limit: number; windowMs: number };
}

/** http(s) only: the logo is rendered as <img src> on public pages. */
const HttpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');

const CreatePortalSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  welcomeMessage: z.string().max(2000).optional(),
  brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  logoUrl: HttpUrl.optional(),
  allowNewFeedback: z.boolean().optional(),
  requireEmail: z.boolean().optional(),
});

const PortalAccessSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(200).optional(),
});

/** PATCH /portals/:id — every field optional, nothing else accepted. */
const UpdatePortalSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    welcomeMessage: z.string().max(2000).nullable().optional(),
    brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    logoUrl: HttpUrl.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export function createClientPortalRoutes(deps: ClientPortalRouteDeps): Router {
  const { authMiddleware, db, mailer } = deps;
  const router = Router();
  registerSessionDb(db);

  const accessLimiter = rateLimit({
    windowMs: deps.accessRateLimit?.windowMs ?? 15 * 60 * 1000,
    limit: deps.accessRateLimit?.limit ?? 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${String(req.params.slug)}:${ipKeyGenerator(req.ip ?? '')}`,
    message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, please try again later.' } },
  });

  // === Admin routes (auth required) ===

  // POST /api/v1/portals — create portal
  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreatePortalSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid portal config.', parsed.error.flatten()); return; }

    // Org match + owner/team-member access (prevent IDOR)
    const project = await findAccessibleProject(db, req.user!, parsed.data.projectId);
    if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }); return; }

    let portal: Record<string, unknown> | undefined;
    try {
      [portal] = await db('client_portals').insert({
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
    } catch (e) {
      if ((e as { code?: string } | null)?.code === '23505') {
        res.status(409).json({ error: { code: 'SLUG_TAKEN', message: 'That portal address is already taken.', details: {} } });
        return;
      }
      throw e;
    }
    res.status(201).json({ portal });
  });

  // GET /api/v1/portals — list org's portals
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const base = db('client_portals').where('org_id', req.user!.orgId);
    const [{ count: total }] = await base.clone().count('* as count');
    const data = await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
  });

  // PATCH /api/v1/portals/:id — edit branding / activation (owner/admin, same org only)
  router.patch('/:id', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    const notFound = () => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } });
    if (!isUuid(req.params.id)) { notFound(); return; }
    const parsed = UpdatePortalSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendZodFailure(res, 'Invalid portal update.', parsed.error.flatten()); return; }
    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.title !== undefined) patch.title = d.title;
    if (d.welcomeMessage !== undefined) patch.welcome_message = d.welcomeMessage;
    if (d.brandColor !== undefined) patch.brand_color = d.brandColor;
    if (d.logoUrl !== undefined) patch.logo_url = d.logoUrl;
    if (d.active !== undefined) patch.active = d.active;
    if (Object.keys(patch).length === 0) {
      sendZodFailure(res, 'Nothing to update.', { formErrors: ['At least one field is required.'], fieldErrors: {} });
      return;
    }
    const [portal] = await db('client_portals')
      .where({ id: req.params.id, org_id: req.user!.orgId })
      .update(patch)
      .returning('*');
    if (!portal) { notFound(); return; }
    res.json({ portal });
  });

  // DELETE /api/v1/portals/:id
  router.delete('/:id', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    const deleted = await db('client_portals').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    if (!deleted) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }
    res.status(204).end();
  });

  // === Guest routes (no auth — token-based) ===

  // GET /portal/:slug — public portal info
  router.get('/:slug/info', systemScope, async (req: Request, res: Response) => {
    const portal = await db('client_portals').where({ slug: req.params.slug, active: true }).first();
    if (!portal) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }
    const { id, title, welcome_message, brand_color, logo_url, allow_new_feedback, require_email } = portal;
    res.json({ portal: { id, title, welcomeMessage: welcome_message, brandColor: brand_color, logoUrl: logo_url, allowNewFeedback: allow_new_feedback, requireEmail: require_email } });
  });

  // POST /portal/:slug/access — request a magic link
  //
  // The caller supplies an email but has not proven they own it, so NO token
  // is ever returned here: the link is emailed to the supplied address and the
  // response is identical whether or not the portal exists / the mail went out.
  router.post('/:slug/access', systemScope, accessLimiter, async (req: Request, res: Response) => {
    const parsed = PortalAccessSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid access request.', parsed.error.flatten()); return; }
    const slug = String(req.params.slug);
    const generic = () => res.status(202).json({ message: ACCESS_REQUEST_MESSAGE });

    const portal = await db('client_portals').where({ slug, active: true }).first();
    if (!portal || !mailer) { generic(); return; }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_MS);
    const email = parsed.data.email.trim().toLowerCase();

    // Only the hash is stored.
    await db('portal_sessions').insert({
      portal_id: portal.id,
      email,
      name: parsed.data.name,
      token: sha256(token),
      expires_at: expiresAt,
    });

    const base = (deps.appUrl ?? '').replace(/\/+$/, '');
    const link = `${base}/portal/${encodeURIComponent(slug)}?token=${token}`;
    const title = escapeHtml(String(portal.title ?? 'Client portal'));
    try {
      await mailer.send({
        to: email,
        subject: `Your access link for ${String(portal.title ?? 'the client portal')}`,
        body:
          `<p>Use the link below to view feedback on <strong>${title}</strong>. ` +
          `It expires in 24 hours.</p><p><a href="${escapeHtml(link)}">Open the portal</a></p>` +
          `<p>If you did not request this, you can ignore this email.</p>`,
      });
    } catch {
      // Same response either way — delivery problems must not be observable.
    }
    generic();
  });

  // GET /portal/:slug/feedback — view feedback (token required)
  router.get('/:slug/feedback', systemScope, async (req: Request, res: Response) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }); return; }

    const session = await db('portal_sessions').where({ token: sha256(token) }).where('expires_at', '>', new Date()).first();
    if (!session) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }); return; }

    // The session is bound to one portal; it must be the portal in the URL.
    const portal = await db('client_portals').where({ id: session.portal_id, slug: String(req.params.slug), active: true }).first();
    if (!portal) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portal not found' } }); return; }

    // Explicit column list + DTO: never `SELECT *` (org_id, session replay,
    // captured logs, guest emails, author ids must not reach portal guests).
    const rows = await db('annotations as a')
      .leftJoin('pages as p', 'p.id', 'a.page_id')
      .where({ 'a.project_id': portal.project_id, 'a.org_id': portal.org_id })
      .whereIn('a.status', ['active', 'resolved'])
      .select('a.id', 'a.pin_number', 'a.type', 'a.severity', 'a.status', 'a.body', 'a.created_at', 'p.url as page_url')
      .orderBy('a.created_at', 'desc')
      .limit(100);

    res.json({
      feedback: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        pinNumber: r.pin_number,
        type: r.type,
        severity: r.severity,
        status: r.status,
        body: r.body,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        pageUrl: r.page_url ?? null,
      })),
    });
  });

  return router;
}
