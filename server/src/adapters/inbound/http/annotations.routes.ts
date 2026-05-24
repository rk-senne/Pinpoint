// Inbound HTTP adapter — annotation routes (Phase 1.5 / task 4.9.1).
//
// Two routers are exported from a single factory:
//   - `projectAnnotationsRouter` — mounted at
//     `/api/v1/projects/:id/annotations` (create + list scoped by
//     project id).
//   - `annotationRouter` — mounted at `/api/v1/annotations` (PUT,
//     DELETE, status, screenshot upload + URL fetch).
//
// All handlers are thin: validate input via Zod (re-using the shared
// schemas where they exist), call exactly one Use_Case, and translate
// the result into the legacy response shape so the existing tests
// against the new modules can match wire-for-wire.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import {
  AnnotationStatusSchema,
  AnnotationTypeSchema,
  CapturedConsoleEntrySchema,
  CapturedNetworkEntrySchema,
  DOMTargetSchema,
  EnvironmentMetadataSchema,
  MarkupDocumentSchema,
  SeveritySchema,
} from '@pinpoint/shared';

import type { CreateAnnotation } from '../../../domain/annotation/usecases/createAnnotation.js';
import type { UpdateAnnotation } from '../../../domain/annotation/usecases/updateAnnotation.js';
import type { ChangeAnnotationStatus } from '../../../domain/annotation/usecases/changeAnnotationStatus.js';
import type { DeleteAnnotation } from '../../../domain/annotation/usecases/deleteAnnotation.js';
import type { AttachScreenshot } from '../../../domain/annotation/usecases/attachScreenshot.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { AnnotationPatch } from '../../../domain/annotation/Annotation.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface AnnotationRouteDeps {
  createAnnotation: CreateAnnotation;
  updateAnnotation: UpdateAnnotation;
  changeAnnotationStatus: ChangeAnnotationStatus;
  deleteAnnotation: DeleteAnnotation;
  attachScreenshot: AttachScreenshot;
  /**
   * Read-only repo handle so the list endpoint can serve the
   * `pageId → pageUrl` projection without inventing a use case for a
   * projection-only operation.
   */
  annotationRepo: AnnotationRepo;
  /**
   * Optional helper that resolves a list of annotations into their
   * page URLs. Provided by the composition root so the inbound layer
   * does not import the page repo directly.
   */
  resolvePageUrls: (
    annotations: { pageId: string }[],
    projectId: string,
  ) => Promise<Map<string, string>>;
  /** Per-port screenshot URL builder (composition root supplies). */
  buildScreenshotUrl: (objectKey: string) => string;
  /** Optional pre-upload buffer transform (e.g., redaction blur). */
  applyRedactionBlur?: (
    buffer: Buffer,
    rects: Array<{ x: number; y: number; width: number; height: number }>,
  ) => Promise<Buffer>;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Maximum allowed screenshot size in bytes. Defaults to 10 MB. */
  screenshotMaxBytes?: number;
}

const SCREENSHOT_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

const ClientRequestIdSchema = z.string().uuid();

const CreateAnnotationBodySchema = z.object({
  type: AnnotationTypeSchema,
  severity: SeveritySchema.optional(),
  body: z.string().min(1),
  pageUrl: z.string().min(1),
  target: DOMTargetSchema,
  environment: EnvironmentMetadataSchema.optional(),
  guidelineId: z.string().optional(),
  clientRequestId: ClientRequestIdSchema.optional(),
  capturedConsole: z.array(CapturedConsoleEntrySchema).nullable().optional(),
  capturedNetwork: z.array(CapturedNetworkEntrySchema).nullable().optional(),
});

const UpdateAnnotationBodySchema = z
  .object({
    body: z.string().min(1).optional(),
    severity: SeveritySchema.optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) =>
          v === undefined ||
          v === null ||
          (typeof v === 'string' && !Number.isNaN(Date.parse(v))),
        { message: 'dueDate must be a valid ISO 8601 date string or null.' },
      ),
  })
  .strict();

const StatusBodySchema = z.object({
  status: AnnotationStatusSchema,
});

const RedactionRectSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
const RedactionRectsSchema = z.array(RedactionRectSchema);

function formatAnnotation(a: {
  id: string;
  projectId: string;
  pageId: string;
  type: string;
  severity: string;
  status: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  target: unknown;
  environment: unknown;
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string;
  pinNumber: number;
  screenshotObjectKey?: string;
  capturedConsole?: unknown;
  capturedNetwork?: unknown;
  clientRequestId?: string;
}, pageUrl: string | undefined): Record<string, unknown> {
  return {
    id: a.id,
    projectId: a.projectId,
    pageId: a.pageId,
    pageUrl: pageUrl ?? null,
    type: a.type,
    severity: a.severity,
    status: a.status,
    body: a.body,
    authorId: a.authorId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    target: a.target,
    environment: a.environment,
    guidelineId: a.guidelineId,
    assigneeId: a.assigneeId,
    dueDate: a.dueDate,
    pinNumber: a.pinNumber,
    screenshotObjectKey: a.screenshotObjectKey,
    capturedConsole: a.capturedConsole,
    capturedNetwork: a.capturedNetwork,
    clientRequestId: a.clientRequestId,
  };
}

export interface AnnotationRouterPair {
  /** Mounted at `/api/v1/projects/:id/annotations`. */
  projectAnnotationsRouter: Router;
  /** Mounted at `/api/v1/annotations`. */
  annotationRouter: Router;
}

export function createAnnotationRoutes(
  deps: AnnotationRouteDeps,
): AnnotationRouterPair {
  const {
    createAnnotation,
    updateAnnotation,
    changeAnnotationStatus,
    deleteAnnotation,
    attachScreenshot,
    annotationRepo,
    resolvePageUrls,
    applyRedactionBlur,
    authMiddleware,
    screenshotMaxBytes = SCREENSHOT_MAX_BYTES_DEFAULT,
  } = deps;

  const screenshotUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: screenshotMaxBytes },
  });

  // ----- Project-scoped routes (create, list) -----------------------------
  const projectAnnotationsRouter = Router({ mergeParams: true });
  projectAnnotationsRouter.use(authMiddleware);

  projectAnnotationsRouter.post('/', async (req: Request, res: Response) => {
    const parsed = CreateAnnotationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid annotation payload.', parsed.error.flatten());
      return;
    }
    const projectId = paramString((req.params as { id?: string | string[] }).id);
    const userId = req.user!.userId;

    if (!parsed.data.environment) {
      res.status(400).json({
        error:
          'Invalid environment. Must include browserFamily, browserVersion, osFamily, osVersion, deviceType, userAgentRaw.',
      });
      return;
    }

    const result = await createAnnotation.execute({
      projectId,
      authorUserId: userId,
      pageUrl: parsed.data.pageUrl,
      type: parsed.data.type,
      severity: parsed.data.severity ?? 'informational',
      body: parsed.data.body,
      target: parsed.data.target,
      environment: parsed.data.environment,
      ...(parsed.data.guidelineId !== undefined
        ? { guidelineId: parsed.data.guidelineId }
        : {}),
      ...(parsed.data.capturedConsole !== undefined
        ? { capturedConsole: parsed.data.capturedConsole }
        : {}),
      ...(parsed.data.capturedNetwork !== undefined
        ? { capturedNetwork: parsed.data.capturedNetwork }
        : {}),
      ...(parsed.data.clientRequestId !== undefined
        ? { clientRequestId: parsed.data.clientRequestId }
        : {}),
    });

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const { annotation, pageUrl, idempotentReplay } = result.value;
    if (idempotentReplay) {
      res.setHeader('X-FL-Idempotent-Replay', 'true');
      res.status(200).json({ annotation: formatAnnotation(annotation, pageUrl) });
      return;
    }
    res.status(201).json({ annotation: formatAnnotation(annotation, pageUrl) });
  });

  projectAnnotationsRouter.get('/', async (req: Request, res: Response) => {
    const projectId = paramString((req.params as { id?: string | string[] }).id);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    let statusFilter: AnnotationPatch['status'] | undefined;
    if (statusRaw !== undefined) {
      const statusResult = AnnotationStatusSchema.safeParse(statusRaw);
      if (!statusResult.success) {
        sendZodFailure(res, 'Invalid status filter.', statusResult.error.flatten());
        return;
      }
      statusFilter = statusResult.data;
    }

    // The list path is a thin projection — no domain logic beyond
    // owner/team-membership scoping (already enforced by future use cases).
    // Until a `ListAnnotations` use case lands, fall back to the repo
    // directly and let the composition root layer in access checks via a
    // wrapper if it wants to.
    const annotations = await annotationRepo.listByProject(
      projectId,
      statusFilter !== undefined ? { status: statusFilter } : undefined,
    );
    const pageUrlByPageId = await resolvePageUrls(annotations, projectId);
    res.status(200).json({
      annotations: annotations.map((a) =>
        formatAnnotation(a, pageUrlByPageId.get(a.pageId)),
      ),
    });
  });

  // ----- Standalone annotation routes (PUT, DELETE, status, screenshot) ---
  const annotationRouter = Router();
  annotationRouter.use(authMiddleware);

  annotationRouter.put('/:id', async (req: Request, res: Response) => {
    const parsed = UpdateAnnotationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid annotation update payload.', parsed.error.flatten());
      return;
    }
    const patch: AnnotationPatch = {};
    if (parsed.data.body !== undefined) patch.body = parsed.data.body.trim();
    if (parsed.data.severity !== undefined) patch.severity = parsed.data.severity;
    if (parsed.data.assigneeId !== undefined) patch.assigneeId = parsed.data.assigneeId;
    if (parsed.data.dueDate !== undefined) patch.dueDate = parsed.data.dueDate;

    const result = await updateAnnotation.execute({
      annotationId: paramString(req.params.id),
      actorUserId: req.user!.userId,
      patch,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ annotation: formatAnnotation(result.value.annotation, undefined) });
  });

  annotationRouter.delete('/:id', async (req: Request, res: Response) => {
    const result = await deleteAnnotation.execute({
      annotationId: paramString(req.params.id),
      actorUserId: req.user!.userId,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ message: 'Annotation deleted successfully.' });
  });

  annotationRouter.put('/:id/status', async (req: Request, res: Response) => {
    const parsed = StatusBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid status payload.', parsed.error.flatten());
      return;
    }
    const result = await changeAnnotationStatus.execute({
      annotationId: paramString(req.params.id),
      actorUserId: req.user!.userId,
      status: parsed.data.status,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ annotation: formatAnnotation(result.value.annotation, undefined) });
  });

  annotationRouter.post(
    '/:id/screenshot',
    screenshotUpload.single('image'),
    async (req: Request, res: Response) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({
          error:
            'Missing `image` file part. Send the screenshot as multipart/form-data with field name `image`.',
        });
        return;
      }
      if (file.mimetype !== 'image/png') {
        res
          .status(400)
          .json({ error: 'Image must be a PNG (Content-Type: image/png).' });
        return;
      }

      // Optional `redactionRects` field (JSON-encoded string in form-data).
      let rects: Array<{ x: number; y: number; width: number; height: number }> = [];
      if (req.body && req.body.redactionRects !== undefined) {
        const raw = req.body.redactionRects;
        let parsed: unknown;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            res
              .status(400)
              .json({ error: 'redactionRects must be a JSON-encoded array.' });
            return;
          }
        } else {
          parsed = raw;
        }
        const result = RedactionRectsSchema.safeParse(parsed);
        if (!result.success) {
          sendZodFailure(res, 'Invalid redactionRects payload.', result.error.flatten());
          return;
        }
        rects = result.data;
      }

      // Optional Markup_Document JSON.
      let markupDocument: unknown;
      if (
        req.body &&
        req.body.markupDocument !== undefined &&
        req.body.markupDocument !== null &&
        req.body.markupDocument !== ''
      ) {
        const raw = req.body.markupDocument;
        let parsed: unknown;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.status(400).json({
              error: 'markupDocument must be a JSON-encoded Markup_Document.',
            });
            return;
          }
        } else {
          parsed = raw;
        }
        const result = MarkupDocumentSchema.safeParse(parsed);
        if (!result.success) {
          sendZodFailure(res, 'Invalid markupDocument payload.', result.error.flatten());
          return;
        }
        markupDocument = result.data;
      }

      const persistBuffer =
        applyRedactionBlur !== undefined
          ? await applyRedactionBlur(file.buffer, rects)
          : file.buffer;

      const result = await attachScreenshot.execute({
        annotationId: paramString(req.params.id),
        actorUserId: req.user!.userId,
        body: persistBuffer,
        contentType: 'image/png',
        ...(markupDocument !== undefined ? { markupDocument } : {}),
      });
      if (!result.ok) {
        sendDomainError(res, result.error);
        return;
      }
      res.status(200).json({
        screenshotObjectKey: result.value.screenshotObjectKey,
        screenshotUrl: result.value.screenshotUrl,
        markupObjectKey: result.value.markupObjectKey,
        markupUrl: result.value.markupUrl,
      });
    },
  );

  return { projectAnnotationsRouter, annotationRouter };
}
