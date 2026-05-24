// getProject use case for the `GET /api/v1/projects/:id` flow.
//
// Returns the Project enriched with annotation count and the full
// member listing (team members plus the project owner) so the dashboard
// detail view can render headcount, role badges, and assignee dropdowns
// without an extra round-trip.
//
// Access policy: owner always; team members of the project's team
// always; everyone else gets `Forbidden`.

import type { Project } from '../Project.js';
import type { ProjectMember, ProjectRepo } from '../ports/ProjectRepo.js';
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

export interface GetProjectInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
}

export interface GetProjectOutput {
  project: Project;
  annotationCount: number;
  /** Project owner (first) followed by each team member, deduplicated. */
  members: ProjectMember[];
}

export interface GetProjectDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class GetProject {
  constructor(private readonly deps: GetProjectDeps) {}

  async execute(
    input: GetProjectInput,
  ): Promise<Result<GetProjectOutput, DomainError>> {
    const { projectRepo, teamMemberRepo } = this.deps;

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    const allowed = await hasProjectAccess(
      teamMemberRepo,
      project.ownerId,
      project.teamId,
      input.userId,
    );
    if (!allowed) {
      return err(new Forbidden('You do not have access to this project.'));
    }

    const [annotationCount, members] = await Promise.all([
      projectRepo.countAnnotations(project.id),
      projectRepo.listMembers(project.id),
    ]);

    return ok({ project, annotationCount, members });
  }
}
