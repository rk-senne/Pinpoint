// attachScreenshot use case for the
// `POST /api/annotations/:id/screenshot` flow. The use case orchestrates
// the persist-then-link sequence:
//   1. Resolve the annotation + project, gate by access.
//   2. Hand the PNG bytes to `ScreenshotStore.uploadScreenshot`.
//   3. Optionally persist a Markup_Document sibling JSON.
//   4. Update the annotation row's `screenshotObjectKey`.
//
// Image MIME validation, multipart parsing, and the optional Gaussian
// blur over redaction rects all live in the inbound HTTP adapter — by
// the time this layer runs, the buffer is the final bytes that will
// land in object storage, and the Markup_Document (when present) has
// already been parsed and validated against the shared Zod schema.

import type { AnnotationRepo } from '../ports/AnnotationRepo.js';
import type { ScreenshotStore } from '../ports/ScreenshotStore.js';
import type { ProjectRepo } from '../../project/ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import { hasProjectAccess } from '../../shared/projectAccess.js';
import {
  Forbidden,
  NotFound,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface AttachScreenshotInput {
  annotationId: string;
  actorUserId: string;
  /** PNG bitmap, post-redaction (the adapter applies any blur first). */
  body: Buffer;
  contentType: string;
  /** Pre-validated Markup_Document JSON to persist as a sibling object. */
  markupDocument?: unknown;
}

export interface AttachScreenshotOutput {
  screenshotObjectKey: string;
  screenshotUrl: string;
  markupObjectKey?: string;
  markupUrl?: string;
}

export interface AttachScreenshotDeps {
  annotationRepo: AnnotationRepo;
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
  screenshotStore: ScreenshotStore;
}

export class AttachScreenshot {
  constructor(private readonly deps: AttachScreenshotDeps) {}

  async execute(
    input: AttachScreenshotInput,
  ): Promise<Result<AttachScreenshotOutput, DomainError>> {
    const { annotationRepo, projectRepo, teamMemberRepo, screenshotStore } =
      this.deps;

    const annotation = await annotationRepo.findById(input.annotationId);
    if (!annotation) {
      return err(new NotFound('Annotation not found.'));
    }

    const project = await projectRepo.findById(annotation.projectId);
    if (!project) {
      return err(new NotFound('Associated project not found.'));
    }

    const allowed = await hasProjectAccess(
      teamMemberRepo,
      project.ownerId,
      project.teamId,
      input.actorUserId,
    );
    if (!allowed) {
      return err(
        new Forbidden('You do not have access to this annotation.'),
      );
    }

    const upload = await screenshotStore.uploadScreenshot({
      annotationId: input.annotationId,
      body: input.body,
      contentType: input.contentType,
    });

    let markupResult: { objectKey: string; url: string } | undefined;
    if (input.markupDocument !== undefined) {
      const r = await screenshotStore.uploadMarkupDocument({
        screenshotKey: upload.objectKey,
        markupDocument: input.markupDocument,
      });
      markupResult = { objectKey: r.objectKey, url: r.url };
    }

    await annotationRepo.setScreenshotKey(input.annotationId, upload.objectKey);

    return ok({
      screenshotObjectKey: upload.objectKey,
      screenshotUrl: upload.url,
      markupObjectKey: markupResult?.objectKey,
      markupUrl: markupResult?.url,
    });
  }
}
