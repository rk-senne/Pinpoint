// computeAnalytics use case (Phase 1.5 / task 4.7.9).
//
// Returns project-scoped roll-ups across severity, type, status, and
// browser dimensions (Req 16). The actual aggregation is owned by the
// `AnalyticsRepo` adapter — this use case enforces project existence and
// access control and forwards the result.
//
// Access policy: project owners always have access; team members of
// the project's owning team have access; everyone else gets a
// `Forbidden`.

import { Forbidden, NotFound, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { ProjectRepo } from '../../project/ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { AnalyticsBuckets, AnalyticsRepo } from '../ports/AnalyticsRepo.js';

export interface ComputeAnalyticsInput {
  /** Caller's user id. */
  userId: string;
  projectId: string;
}

export interface ComputeAnalyticsDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
  analyticsRepo: AnalyticsRepo;
}

export class ComputeAnalytics {
  constructor(private readonly deps: ComputeAnalyticsDeps) {}

  async execute(
    input: ComputeAnalyticsInput,
  ): Promise<Result<AnalyticsBuckets, DomainError>> {
    const { projectRepo, teamMemberRepo, analyticsRepo } = this.deps;

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    const isOwner = project.ownerId === input.userId;
    let isTeamMember = false;
    if (!isOwner && project.teamId) {
      const membership = await teamMemberRepo.findByTeamAndUser(
        project.teamId,
        input.userId,
      );
      isTeamMember = membership != null;
    }

    if (!isOwner && !isTeamMember) {
      return err(new Forbidden('You do not have access to this project.'));
    }

    const buckets = await analyticsRepo.computeForProject(input.projectId);
    return ok(buckets);
  }
}
