// Widget feedback endpoint — public (no auth middleware), rate-limited.
//
// Accepts feedback submissions from the embeddable widget. Authenticates
// via an `X-Project-Key` header whose SHA-256 hash is validated against the
// `api_keys` table. Only `pk_widget_` keys (`key_type = 'widget'`) are
// accepted, and each such key is bound to exactly ONE project via its
// `project_id` column (Mission A1) — the old org-first
// `.orderBy('created_at').first()` target let a leaked key write across the
// whole org and has been removed.
//
// Request bodies are validated (and capped) server-side with Zod (Mission
// B2: description ≤ 2000 chars) regardless of what the client sends. The
// per-key Redis fail-closed rate limiter + daily quota (Mission A3) run
// ahead of the handler.

import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApiKey, ApiKeyRepo } from '../../../domain/org/ports/ApiKeyRepo.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { NewAnnotation } from '../../../domain/annotation/Annotation.js';
import type { CreateGuestAnnotation } from '../../../domain/annotation/usecases/createAnnotation.js';
import { parseUserAgent } from '@pinpoint/shared';
import { ConsoleLogsSchema, JsErrorsSchema } from '@pinpoint/shared';
import { isHttpUrl } from './errors.js';
import { createWidgetRateLimit, type WidgetRateLimitRedis } from '../../../middleware/widgetRateLimit.js';

/** Server-side body cap for widget submissions (Mission B2). */
export const WIDGET_DESCRIPTION_MAX = 2000;

export interface WidgetRouteDeps {
  apiKeyRepo: ApiKeyRepo;
  /** Kept for deps-shape compatibility; writes go through createGuestAnnotation. */
  annotationRepo?: AnnotationRepo;
  /**
   * Transactional guest create: resolves/creates the page for `pageUrl`,
   * allocates the next pin atomically, inserts with author_id NULL +
   * is_guest, and broadcasts `annotation.created`.
   */
  createGuestAnnotation: Pick<CreateGuestAnnotation, 'execute'>;
  /** Redis client for the fail-closed limiter; omit (tests) for in-memory. */
  rateLimitRedis?: WidgetRateLimitRedis;
}

const WidgetFeedbackSchema = z.object({
  description: z.string().trim().min(1, 'description is required.').max(
    WIDGET_DESCRIPTION_MAX,
    `description must be ${WIDGET_DESCRIPTION_MAX} characters or fewer.`,
  ),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  email: z.string().email().max(255).optional(),
  pageUrl: z
    .string()
    .min(1, 'pageUrl is required.')
    .max(2000)
    .refine(isHttpUrl, 'pageUrl must be an http(s) URL.'),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
  }),
  userAgent: z.string().min(1, 'userAgent is required.'),
  // Diagnostics capture (Mission C2). Optional + bounded (≤50 entries each,
  // per-message/stack length caps) by the shared schemas. The hard ≤32 KB
  // serialized cap is re-enforced below with `enforceDiagnosticsBudget`.
  consoleLogs: ConsoleLogsSchema,
  jsErrors: JsErrorsSchema,
});

/** Server-side ≤32 KB cap on the serialized diagnostics payload (Mission C2). */
export const WIDGET_DIAGNOSTICS_MAX_BYTES = 32 * 1024;

/**
 * Drop the diagnostics arrays when their serialized size exceeds the budget.
 * A single oversized field is dropped independently so a huge `jsErrors` can
 * not evict a reasonable `consoleLogs`. Returns the fields to persist.
 */
export function enforceDiagnosticsBudget(input: {
  consoleLogs?: unknown;
  jsErrors?: unknown;
}): { consoleLogs?: unknown; jsErrors?: unknown } {
  const out: { consoleLogs?: unknown; jsErrors?: unknown } = {};
  if (input.consoleLogs != null) {
    const size = Buffer.byteLength(JSON.stringify(input.consoleLogs), 'utf8');
    if (size <= WIDGET_DIAGNOSTICS_MAX_BYTES) out.consoleLogs = input.consoleLogs;
  }
  if (input.jsErrors != null) {
    const size = Buffer.byteLength(JSON.stringify(input.jsErrors), 'utf8');
    if (size <= WIDGET_DIAGNOSTICS_MAX_BYTES) out.jsErrors = input.jsErrors;
  }
  return out;
}

/** Stash the resolved widget key so CORS + rate-limit middleware can read it. */
function setResolvedApiKey(req: Request, apiKey: ApiKey): void {
  (req as Request & { apiKey?: ApiKey }).apiKey = apiKey;
}

export function createWidgetRoutes(deps: WidgetRouteDeps): Router {
  const router = Router();
  const { apiKeyRepo, createGuestAnnotation } = deps;

  const widgetLimiter = createWidgetRateLimit(
    { getApiKey: (req) => (req as Request & { apiKey?: ApiKey }).apiKey },
    deps.rateLimitRedis
      ? { store: 'redis', redis: deps.rateLimitRedis, failMode: 'closed' }
      : { store: 'memory', failMode: 'closed' },
  );

  // Resolve + authenticate the widget key, then enforce the rate limit.
  async function authenticateWidgetKey(
    req: Request,
    res: Response,
    next: () => void,
  ): Promise<void> {
    const projectKey = req.headers['x-project-key'] as string | undefined;
    if (!projectKey) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'X-Project-Key header is required.', details: {} },
      });
      return;
    }

    const keyHash = createHash('sha256').update(projectKey).digest('hex');
    const apiKey = await apiKeyRepo.findByHash(keyHash);

    if (!apiKey || apiKey.keyType !== 'widget') {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid project key.', details: {} },
      });
      return;
    }

    if (!apiKey.scopes.includes('widget')) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'API key does not have widget scope.', details: {} },
      });
      return;
    }

    if (!apiKey.projectId) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Widget key is not bound to a project.', details: {} },
      });
      return;
    }

    // Per-key origin allow-list, enforced server-side. CORS alone only
    // stops the browser from READING the response — the write would
    // still happen. Requests without an Origin (server-to-server, curl)
    // carry no ambient browser context and are allowed; browsers always
    // send Origin on cross-origin POSTs. This runs BEFORE the rate limiter
    // (F-20) so traffic from a disallowed origin can never burn the
    // legitimate key's burst/daily quota.
    const origin = req.headers.origin;
    if (origin && apiKey.allowedOrigins.length > 0 && !apiKey.allowedOrigins.includes(origin)) {
      res.status(403).json({
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not allowed for this widget key.', details: {} },
      });
      return;
    }

    setResolvedApiKey(req, apiKey);
    next();
  }

  // POST /api/v1/widget/feedback
  router.post(
    '/feedback',
    (req, res, next) => {
      authenticateWidgetKey(req, res, () => next()).catch(next);
    },
    widgetLimiter,
    async (req: Request, res: Response) => {
      const apiKey = (req as Request & { apiKey?: ApiKey }).apiKey!;

      const parsed = WidgetFeedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'Invalid widget feedback payload.',
            details: { issues: parsed.error.flatten() },
          },
        });
      }

      const { description, severity, email, pageUrl, viewport, userAgent } = parsed.data;

      const resolvedSeverity = severity ?? 'informational';

      const ua = parseUserAgent(userAgent);

      // Mission C2 — re-enforce the ≤32 KB serialized diagnostics budget
      // server-side regardless of what the widget sent.
      const diagnostics = enforceDiagnosticsBudget({
        consoleLogs: parsed.data.consoleLogs ?? undefined,
        jsErrors: parsed.data.jsErrors ?? undefined,
      });

      const result = await createGuestAnnotation.execute({
        projectId: apiKey.projectId!,
        orgId: apiKey.orgId,
        pageUrl,
        type: 'note',
        severity: resolvedSeverity,
        body: email
          ? `${description.trim()}\n\n---\nSubmitted via widget\nContact: ${email}`
          : `${description.trim()}\n\n---\nSubmitted via widget`,
        guest: { name: null, email: email ?? null },
        target: {
          cssSelector: 'body',
          xpath: '/html/body',
          pageX: 0,
          pageY: 0,
          tagName: 'BODY',
          textSnippet: 'Widget submission',
        },
        environment: {
          browserFamily: ua.browserFamily,
          browserVersion: ua.browserVersion,
          osFamily: ua.osFamily,
          osVersion: ua.osVersion,
          deviceType: ua.deviceType,
          userAgentRaw: userAgent,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        },
        ...(diagnostics.consoleLogs !== undefined
          ? { consoleLogs: diagnostics.consoleLogs as NewAnnotation['consoleLogs'] }
          : {}),
        ...(diagnostics.jsErrors !== undefined
          ? { jsErrors: diagnostics.jsErrors as NewAnnotation['jsErrors'] }
          : {}),
      });
      if (!result.ok) {
        // Bound project was deleted after the key was issued.
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} },
        });
      }
      const annotation = result.value.annotation;

      await apiKeyRepo.updateLastUsed(apiKey.id);

      res.status(201).json({ data: { id: annotation.id } });
    },
  );

  return router;
}
