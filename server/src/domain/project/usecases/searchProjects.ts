// searchProjects use case (Phase 1.5 / task 4.7.2).
//
// Implements `GET /api/v1/projects`. Returns every Project the caller
// owns OR is a team-member of, with optional `search` (case-insensitive
// name LIKE) and `status` filters.
// Owner / team-membership scoping lives inside `ProjectRepo.search`; the
// use case is mostly a thin pass-through that exists so the inbound
// adapter has a single seam to depend on.

import type { Project } from '../Project.js';
import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { ProjectStatus } from '../Project.js';
import {
  type DomainError,
  type Result,
  ok,
} from '../../shared/DomainError.js';

export interface SearchProjectsInput {
  /** Caller's user id. */
  userId: string;
  search?: string;
  status?: ProjectStatus;
}

export interface SearchProjectsOutput {
  projects: Project[];
}

export interface SearchProjectsDeps {
  projectRepo: ProjectRepo;
}

export class SearchProjects {
  constructor(private readonly deps: SearchProjectsDeps) {}

  async execute(
    input: SearchProjectsInput,
  ): Promise<Result<SearchProjectsOutput, DomainError>> {
    const { projectRepo } = this.deps;

    const repoInput: Parameters<ProjectRepo['search']>[0] = {
      userId: input.userId,
    };
    if (input.search !== undefined) repoInput.search = input.search;
    if (input.status !== undefined) repoInput.status = input.status;

    const projects = await projectRepo.search(repoInput);
    return ok({ projects });
  }
}
