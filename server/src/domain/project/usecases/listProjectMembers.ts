// listProjectMembers use case for the `GET /api/v1/projects/:id/members`
// flow (Req 22.4). Returns the project owner first followed by every
// team member, deduplicated. Consumers include the dashboard assignee
// dropdown and the extension's mention autocomplete.

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

export interface ListProjectMembersInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
}

export interface ListProjectMembersOutput {
  members: ProjectMember[];
}

export interface ListProjectMembersDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class ListProjectMembers {
  constructor(private readonly deps: ListProjectMembersDeps) {}

  async execute(
    input: ListProjectMembersInput,
  ): Promise<Result<ListProjectMembersOutput, DomainError>> {
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

    const members = await projectRepo.listMembers(project.id);
    return ok({ members });
  }
}
