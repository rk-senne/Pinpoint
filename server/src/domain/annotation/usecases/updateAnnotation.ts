// updateAnnotation use case for the `PUT /api/annotations/:id` flow.
// Applies a partial body / severity / assignee / due-date patch after
// confirming the caller has project access. Field-level validation
// (non-empty body, severity enum, ISO date) lives at the inbound adapter
// — this layer only enforces existence and authorization.

import type { Annotation, AnnotationPatch } from '../Annotation.js';
import type { AnnotationRepo } from '../ports/AnnotationRepo.js';
import type { ProjectRepo } from '../../project/ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { PageRepo } from '../../project/ports/PageRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import { hasProjectAccess } from '../../shared/projectAccess.js';
import {
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface UpdateAnnotationInput {
  annotationId: string;
  actorUserId: string;
  patch: AnnotationPatch;
}

export interface UpdateAnnotationOutput {
  annotation: Annotation;
}

export interface UpdateAnnotationDeps {
  annotationRepo: AnnotationRepo;
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
  /** Broadcasts `annotation.updated` to the project room (realtime + webhooks). */
  eventBus: EventBus;
  /** Resolves `pageUrl` for the broadcast payload (omitted when absent). */
  pageRepo?: PageRepo;
}

export class UpdateAnnotation {
  constructor(private readonly deps: UpdateAnnotationDeps) {}

  async execute(
    input: UpdateAnnotationInput,
  ): Promise<Result<UpdateAnnotationOutput, DomainError>> {
    const { annotationRepo, projectRepo, teamMemberRepo } = this.deps;

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

    if (Object.keys(input.patch).length === 0) {
      return err(new Validation('No valid fields provided for update.'));
    }

    const updated = await annotationRepo.update(input.annotationId, input.patch);

    const page = await this.deps.pageRepo?.findById(updated.pageId);
    this.deps.eventBus.emit({
      type: 'annotation.updated',
      room: `project:${updated.projectId}`,
      payload: { ...updated, pageUrl: page?.url ?? null },
    });
    return ok({ annotation: updated });
  }
}
