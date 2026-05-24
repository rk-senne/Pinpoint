// changeAnnotationStatus use case for the
// `PUT /api/annotations/:id/status` flow. The route's enum validation
// belongs at the inbound adapter; this layer accepts the validated
// `AnnotationStatus` and applies it after the access check.

import type {
  Annotation,
  AnnotationStatus,
} from '../Annotation.js';
import type { AnnotationRepo } from '../ports/AnnotationRepo.js';
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

export interface ChangeAnnotationStatusInput {
  annotationId: string;
  actorUserId: string;
  status: AnnotationStatus;
}

export interface ChangeAnnotationStatusOutput {
  annotation: Annotation;
}

export interface ChangeAnnotationStatusDeps {
  annotationRepo: AnnotationRepo;
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class ChangeAnnotationStatus {
  constructor(private readonly deps: ChangeAnnotationStatusDeps) {}

  async execute(
    input: ChangeAnnotationStatusInput,
  ): Promise<Result<ChangeAnnotationStatusOutput, DomainError>> {
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

    const updated = await annotationRepo.update(input.annotationId, {
      status: input.status,
    });

    return ok({ annotation: updated });
  }
}
