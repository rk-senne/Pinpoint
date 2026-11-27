// createProject use case (Phase 1.5 / task 4.7.2).
//
// Implements `POST /api/v1/projects`. The use case validates input,
// persists the Project, and seeds a matching `pages` row per URL inside
// a single transaction so the unique
// `(project_id, url)` constraint cannot be violated by partial commits
// (Reqs 2.1, 23.1).
//
// URL validation (HTTP/HTTPS protocol, trim, dedupe) is owned by the
// inbound adapter via Zod; the use case re-applies the trim + dedupe
// defensively so direct callers (workers, tests) cannot insert a noisy
// payload.

import type { NewProject, Project } from '../Project.js';
import type { Page } from '../Page.js';
import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { TeamRepo } from '../../team/ports/TeamRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { PageRepo } from '../ports/PageRepo.js';
import {
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

/**
 * Function adapter wrapping the database transaction at the inbound
 * seam. The domain layer never sees the underlying knex / pg handle; the
 * Postgres adapter narrows the opaque `tx` back to its native type.
 */
export type TransactionRunner = <T>(
  fn: (tx: unknown) => Promise<T>,
) => Promise<T>;

export interface CreateProjectInput {
  ownerUserId: string;
  name: string;
  urls: string[];
  teamId?: string;
  orgId?: string;
}

export interface CreateProjectOutput {
  project: Project;
  pages: Page[];
}

export interface CreateProjectDeps {
  projectRepo: ProjectRepo;
  pageRepo: PageRepo;
  /** Wraps the project insert + per-URL page inserts in one transaction. */
  runInTransaction: TransactionRunner;
  /** Needed to validate `teamId` (PP-03). Without them a teamId is rejected (fail closed). */
  teamRepo?: TeamRepo;
  teamMemberRepo?: TeamMemberRepo;
}

export class CreateProject {
  constructor(private readonly deps: CreateProjectDeps) {}

  async execute(
    input: CreateProjectInput,
  ): Promise<Result<CreateProjectOutput, DomainError>> {
    const { projectRepo, pageRepo, runInTransaction } = this.deps;

    const trimmedName = input.name.trim();
    if (trimmedName.length === 0) {
      return err(new Validation('Project name is required.'));
    }

    const trimmedUrls = input.urls.map((u) => u.trim()).filter((u) => u.length > 0);
    if (trimmedUrls.length === 0) {
      return err(new Validation('At least one URL is required.'));
    }
    // Deduplicate while preserving order so the unique (project_id, url)
    // constraint on pages is never violated by a noisy client.
    const uniqueUrls = Array.from(new Set(trimmedUrls));

    // PP-03: the team must be in the caller's org and the caller must be able to
    // manage it. Anything else is a 404 (no existence oracle for foreign teams).
    if (input.teamId) {
      const { teamRepo, teamMemberRepo } = this.deps;
      const team = teamRepo && (await teamRepo.findById(input.teamId));
      const membership =
        team && teamMemberRepo
          ? await teamMemberRepo.findByTeamAndUser(team.id, input.ownerUserId)
          : null;
      const sameOrg = team && (input.orgId === undefined || team.orgId === input.orgId);
      if (!team || !sameOrg || !membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return err(new NotFound('Team not found.'));
      }
    }

    const newProject: NewProject = {
      name: trimmedName,
      urls: uniqueUrls,
      ownerId: input.ownerUserId,
      orgId: input.orgId,
    };
    if (input.teamId) {
      newProject.teamId = input.teamId;
    }

    const result = await runInTransaction(async (tx) => {
      const project = await projectRepo.insert(newProject, tx);
      const pages: Page[] = [];
      for (const url of uniqueUrls) {
        const page = await pageRepo.insert({ projectId: project.id, url, title: null }, tx);
        pages.push(page);
      }
      return { project, pages };
    });

    return ok(result);
  }
}
