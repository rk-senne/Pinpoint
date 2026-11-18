// Inbound HTTP adapter — annotation task delivery (C4).
//
// Two endpoints, both org-scoped exactly like the premium annotation routes
// (`annotations.routes.ts` suggestions/check-regression): the annotation must
// exist AND belong to the caller's org (`annotations.org_id = req.user.orgId`)
// or we 404 — a cross-org id is indistinguishable from a missing one, so
// there is no tenant-enumeration leak.
//
//   POST /api/v1/annotations/:id/deliver   { provider }
//     - 404 if annotation not in caller's org
//     - 409 if the provider integration is not connected for the org
//     - idempotent: if a 'delivered' link already exists, return it (200)
//       without opening a second issue
//     - transient (5xx/network) failures record status='failed' + last_error
//       and return 502; the client re-POSTs to retry (documented below)
//     - permanent (4xx/misconfig) failures record status='failed' and return
//       the mapped canonical error envelope
//
//   GET  /api/v1/annotations/:id/deliveries
//     - lists every external link for the annotation (status + url + error)
//
// RETRY MODEL: there is no clean durable-queue seam for a user-initiated,
// synchronous "Send to…" action (the webhook_deliveries queue is bound to
// webhook_endpoints rows, not annotations). Rather than overload it, a failed
// row is persisted with status='failed'; re-POSTing the same provider retries
// in place and overwrites the row. This keeps delivery idempotent per
// (annotation, provider) and gives the user an explicit retry affordance in
// the dashboard SendToMenu.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import { sendError, sendZodFailure, paramString } from './errors.js';
import { findAccessibleProject, registerSessionDb } from './access.js';
import type { IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';
import {
  type TaskProvider,
  type TaskProviderName,
  TASK_PROVIDERS,
  isTaskProvider,
  TaskDeliveryError,
  createTaskProviders,
} from '../../../services/integrations/index.js';

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  informational: 'Informational',
};

const DeliverBodySchema = z.object({
  provider: z.enum(TASK_PROVIDERS),
});

export interface DeliverRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  integrationRepo: IntegrationRepo;
  db: Knex;
  /**
   * Map of provider name → adapter. Defaults to the real registry; tests
   * inject stubbed adapters (which themselves use a stubbed safeFetch).
   */
  providers?: Record<TaskProviderName, TaskProvider>;
  /** Base URL for building the "View in Pinpoint" deep link. */
  appUrl?: string;
}

interface ExternalLinkRow {
  id: string;
  annotation_id: string;
  provider: string;
  external_id: string | null;
  external_url: string | null;
  status: string;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function formatLink(row: ExternalLinkRow): Record<string, unknown> {
  return {
    provider: row.provider,
    externalId: row.external_id,
    externalUrl: row.external_url,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export function createDeliverRoutes(deps: DeliverRouteDeps): Router {
  const { authMiddleware, integrationRepo, db } = deps;
  const providers = deps.providers ?? createTaskProviders();
  const appUrl = (deps.appUrl ?? '').replace(/\/$/, '');

  const router = Router();
  router.use(authMiddleware);
  registerSessionDb(db);

  // Load the annotation iff it belongs to the caller's org. Returns null on
  // missing OR cross-org (both surface as 404 upstream).
  async function loadOwnedAnnotation(
    annotationId: string,
    orgId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await db('annotations').where({ id: annotationId, org_id: orgId }).first();
    return row ?? null;
  }

  // POST /api/v1/annotations/:id/deliver
  router.post('/:id/deliver', async (req: Request, res: Response) => {
    const annotationId = paramString(req.params.id);
    const parsed = DeliverBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid delivery payload.', parsed.error.flatten());
      return;
    }
    const provider = parsed.data.provider;

    const annotation = await loadOwnedAnnotation(annotationId, req.user!.orgId);
    if (!annotation) {
      sendError(res, 404, 'NOT_FOUND', 'Annotation not found.');
      return;
    }

    // Idempotency: a prior successful delivery short-circuits.
    const existing = (await db('annotation_external_links')
      .where({ annotation_id: annotationId, provider })
      .first()) as ExternalLinkRow | undefined;
    if (existing && existing.status === 'delivered') {
      res.status(200).json({ link: formatLink(existing) });
      return;
    }

    // The provider integration must be connected for this org.
    const integration = await integrationRepo.findByOrgAndProvider(req.user!.orgId, provider);
    if (!integration || !integration.enabled || !integration.accessToken) {
      sendError(res, 409, 'INTEGRATION_NOT_CONNECTED', `The ${provider} integration is not connected.`);
      return;
    }

    const adapter = providers[provider as TaskProviderName];
    if (!adapter) {
      sendError(res, 409, 'INTEGRATION_NOT_CONNECTED', `Provider ${provider} is not available.`);
      return;
    }

    const pinNumber = annotation.pin_number ?? annotation.pinNumber;
    const bodyText = String(annotation.body ?? '');
    const severity = String(annotation.severity ?? 'informational');
    const title = `[Pinpoint #${pinNumber ?? '?'}] ${bodyText.slice(0, 80)}`.trim();
    const deepLink = appUrl
      ? `${appUrl}/project/${annotation.project_id}?annotation=${annotationId}`
      : `/project/${annotation.project_id}?annotation=${annotationId}`;

    try {
      const result = await adapter.createTask(
        { accessToken: integration.accessToken, config: integration.config },
        {
          title,
          body: bodyText,
          url: deepLink,
          severity: SEVERITY_LABEL[severity] ?? severity,
          labels: [`pinpoint`, severity],
        },
      );

      const [row] = (await db('annotation_external_links')
        .insert({
          annotation_id: annotationId,
          provider,
          external_id: result.externalId,
          external_url: result.externalUrl,
          status: 'delivered',
          last_error: null,
          updated_at: db.fn.now(),
        })
        .onConflict(['annotation_id', 'provider'])
        .merge({
          external_id: result.externalId,
          external_url: result.externalUrl,
          status: 'delivered',
          last_error: null,
          updated_at: db.fn.now(),
        })
        .returning('*')) as ExternalLinkRow[];

      res.status(201).json({ link: formatLink(row) });
    } catch (err) {
      const message =
        err instanceof TaskDeliveryError ? err.message : 'Task delivery failed.';
      const transient = err instanceof TaskDeliveryError ? err.transient : true;

      // Record the failure so the UI can show it and the user can re-POST.
      const [row] = (await db('annotation_external_links')
        .insert({
          annotation_id: annotationId,
          provider,
          status: 'failed',
          last_error: message,
          updated_at: db.fn.now(),
        })
        .onConflict(['annotation_id', 'provider'])
        .merge({ status: 'failed', last_error: message, updated_at: db.fn.now() })
        .returning('*')) as ExternalLinkRow[];

      // Transient failures → 502 (retry by re-POSTing); permanent → 422.
      const status = transient ? 502 : 422;
      const code = transient ? 'DELIVERY_FAILED_TRANSIENT' : 'DELIVERY_FAILED';
      sendError(res, status, code, message, { provider, link: formatLink(row) });
    }
  });

  // GET /api/v1/annotations/:id/deliveries
  router.get('/:id/deliveries', async (req: Request, res: Response) => {
    const annotationId = paramString(req.params.id);
    const annotation = await loadOwnedAnnotation(annotationId, req.user!.orgId);
    if (!annotation) {
      sendError(res, 404, 'NOT_FOUND', 'Annotation not found.');
      return;
    }
    const rows = (await db('annotation_external_links')
      .where({ annotation_id: annotationId })
      .orderBy('created_at', 'asc')) as ExternalLinkRow[];
    res.status(200).json({ data: rows.map(formatLink) });
  });

  return router;
}

export { isTaskProvider };
