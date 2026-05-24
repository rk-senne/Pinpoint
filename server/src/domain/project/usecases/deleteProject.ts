// deleteProject use case (Phase 1.5 / task 4.7.2).
//
// Implements `DELETE /api/v1/projects/:id`. Only the project owner may
// delete; the caller must supply `confirmationToken` matching the
// project name to prevent accidental destruction. After the row is
// removed, a
// `project.deleted` event is emitted on the EventBus so the inbound
// adapter can hand off durable `project_deleted` notifications to every
// other team member (Reqs 10.3, 28).

import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import {
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface DeleteProjectInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
  /** Must equal `project.name` for the delete to proceed. */
  confirmationToken?: string;
}

export interface DeleteProjectOutput {
  projectId: string;
  /**
   * User ids of every other project member (team members + owner minus the
   * triggering user) so the inbound adapter can enqueue
   * `project_deleted` notifications. Returned in the result instead of
   * dispatched here so the use case stays free of the notification port
   * and the inbound layer keeps full control over per-user preferences.
   */
  memberIdsToNotify: string[];
}

export interface DeleteProjectDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
  eventBus: EventBus;
}

export class DeleteProject {
  constructor(private readonly deps: DeleteProjectDeps) {}

  async execute(
    input: DeleteProjectInput,
  ): Promise<Result<DeleteProjectOutput, DomainError>> {
    const { projectRepo, teamMemberRepo, eventBus } = this.deps;

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    if (project.ownerId !== input.userId) {
      return err(
        new Forbidden('Only the project owner can delete this project.'),
      );
    }

    if (!input.confirmationToken || input.confirmationToken !== project.name) {
      return err(
        new Validation(
          'Please provide the project name as confirmationToken to confirm deletion.',
        ),
      );
    }

    // Capture the recipient list BEFORE the delete cascades the
    // team_members rows away on FK constraints. The owner triggered the
    // delete so they are skipped.
    const memberIds = new Set<string>();
    if (project.teamId) {
      const members = await teamMemberRepo.listByTeam(project.teamId);
      for (const m of members) memberIds.add(m.userId);
    }
    memberIds.delete(input.userId);

    await projectRepo.delete(project.id);

    eventBus.emit({
      type: 'project.deleted',
      room: `project:${project.id}`,
      payload: {
        projectId: project.id,
        projectName: project.name,
        triggeredBy: input.userId,
      },
    });

    return ok({
      projectId: project.id,
      memberIdsToNotify: [...memberIds],
    });
  }
}
