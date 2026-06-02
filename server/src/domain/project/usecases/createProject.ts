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
import type { PageRepo } from '../ports/PageRepo.js';
import {
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

    const newProject: NewProject = {
      name: trimmedName,
      urls: uniqueUrls,
      ownerId: input.ownerUserId,
      orgId: input.orgId,
    };
    if (input.teamId) {
      newProject.teamId = input.teamId;
    }

    const result = await runInTransaction(async () => {
      const project = await projectRepo.insert(newProject);
      const pages: Page[] = [];
      for (const url of uniqueUrls) {
        const page = await pageRepo.insert({
          projectId: project.id,
          url,
          title: null,
        });
        pages.push(page);
      }
      return { project, pages };
    });

    return ok(result);
  }
}
