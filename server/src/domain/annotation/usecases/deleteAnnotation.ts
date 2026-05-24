// deleteAnnotation use case for the `DELETE /api/annotations/:id` flow.
// The annotation row is removed; FK-cascading children (comments)
// follow per the schema. Pin numbers are NOT reused; the project's
// `pin_counter` keeps marching forward so a deleted pin does not
// collide with future inserts (Req 24.4).

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

export interface DeleteAnnotationInput {
  annotationId: string;
  actorUserId: string;
}

export interface DeleteAnnotationOutput {
  annotationId: string;
}

export interface DeleteAnnotationDeps {
  annotationRepo: AnnotationRepo;
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class DeleteAnnotation {
  constructor(private readonly deps: DeleteAnnotationDeps) {}

  async execute(
    input: DeleteAnnotationInput,
  ): Promise<Result<DeleteAnnotationOutput, DomainError>> {
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

    await annotationRepo.delete(input.annotationId);
    return ok({ annotationId: input.annotationId });
  }
}
