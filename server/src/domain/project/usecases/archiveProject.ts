// archiveProject use case for the `status='archived'` branch of
// `PUT /api/v1/projects/:id`. Toggles the project status; only the
// owner or a team admin may archive.

import type { Project, ProjectStatus } from '../Project.js';
import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import { hasProjectAdminAccess } from '../../shared/projectAccess.js';
import {
  Forbidden,
  NotFound,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface ArchiveProjectInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
  /** Target status. Defaults to 'archived' but accepts 'active' for un-archive. */
  status?: ProjectStatus;
}

export interface ArchiveProjectOutput {
  project: Project;
}

export interface ArchiveProjectDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class ArchiveProject {
  constructor(private readonly deps: ArchiveProjectDeps) {}

  async execute(
    input: ArchiveProjectInput,
  ): Promise<Result<ArchiveProjectOutput, DomainError>> {
    const { projectRepo, teamMemberRepo } = this.deps;

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
        new Forbidden(
          'Only the project owner or team admin can update this project.',
        ),
      );
    }

    const updated = await projectRepo.update(project.id, {
      status: input.status ?? 'archived',
    });
    return ok({ project: updated });
  }
}
