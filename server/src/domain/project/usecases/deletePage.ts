// deletePage use case for the
// `DELETE /api/v1/projects/:id/pages/:pageId` flow (Reqs 23.4, 23.5).
// Removes a Page entity. The `onNonEmpty` mode controls behavior when
// annotations still reference the page:
//
//   - `block` (default) → 409 Conflict; the caller must pass `cascade`
//     to opt in to deleting the children.
//   - `cascade`         → annotations on the page are deleted alongside
//     the page row. The schema's ON DELETE CASCADE FK does the actual
//     work; the use case still surfaces the count for the response.
//
// Authorization: only the project owner or a team admin may delete a
// page.

import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { PageRepo } from '../ports/PageRepo.js';
import type { AnnotationRepo } from '../../annotation/ports/AnnotationRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import { hasProjectAdminAccess } from '../../shared/projectAccess.js';
import {
  Conflict,
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export type DeletePageMode = 'block' | 'cascade';

export interface DeletePageInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
  pageId: string;
  /** Defaults to `block`. */
  onNonEmpty?: DeletePageMode;
}

export interface DeletePageOutput {
  pageId: string;
  /** Number of annotations that were attached to the page. */
  annotationCount: number;
}

export interface DeletePageDeps {
  projectRepo: ProjectRepo;
  pageRepo: PageRepo;
  annotationRepo: AnnotationRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class DeletePage {
  constructor(private readonly deps: DeletePageDeps) {}

  async execute(
    input: DeletePageInput,
  ): Promise<Result<DeletePageOutput, DomainError>> {
    const { projectRepo, pageRepo, annotationRepo, teamMemberRepo } = this.deps;

    const mode: DeletePageMode = input.onNonEmpty ?? 'block';
    if (mode !== 'block' && mode !== 'cascade') {
      return err(
        new Validation(
          'Query parameter `onNonEmpty` must be `block` or `cascade`.',
        ),
      );
    }

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    const allowed = await hasProjectAdminAccess(
      teamMemberRepo,
      project.ownerId,
      project.teamId,
      input.userId,
    );
    if (!allowed) {
      return err(
        new Forbidden('You do not have permission to modify this project.'),
      );
    }

    const page = await pageRepo.findById(input.pageId);
    if (!page || page.projectId !== project.id) {
      return err(new NotFound('Page not found in project.'));
    }

    // Count annotations attached to this page. The port does not expose a
    // direct page-scoped count (intentionally — page deletes are rare),
    // so we filter the project list in memory. The result also drives
    // the `block` 409 path.
    const annotations = await annotationRepo.listByProject(project.id);
    const onPage = annotations.filter((a) => a.pageId === page.id);
    const annotationCount = onPage.length;

    if (mode === 'block' && annotationCount > 0) {
      return err(
        new Conflict(
          'Page has annotations. Pass `onNonEmpty=cascade` to delete them.',
        ),
      );
    }

    // FK cascade on `pages` removes child annotations automatically. The
    // pin counter on `projects` keeps marching forward — pin numbers are
    // monotonic and gaps are allowed (Req 24.4).
    await pageRepo.delete(page.id);

    return ok({ pageId: page.id, annotationCount });
  }
}
