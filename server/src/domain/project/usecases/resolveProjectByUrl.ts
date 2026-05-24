// resolveProjectByUrl use case for the
// `GET /api/v1/projects/by-url?url=<encoded>` flow (Reqs 22.1, 22.2).
// The use case looks up every `pages` row matching the supplied URL and
// returns the first `(projectId, pageId)` pair belonging to a project
// the caller can access (owner or team member).
//
// Per the requirement narrative, the match is keyed on the canonical
// page URL stored at create time (host + pathname, query/fragment
// excluded by the extension before sending). The use case does not
// rewrite the input — adapters at the inbound seam are expected to
// normalize the URL identically to how the extension builds it.

import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { PageRepo } from '../ports/PageRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import { hasProjectAccess } from '../../shared/projectAccess.js';
import {
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface ResolveProjectByUrlInput {
  /** Caller's user id. */
  userId: string;
  /** Full page URL (origin + pathname). */
  url: string;
}

export interface ResolveProjectByUrlOutput {
  projectId: string;
  pageId: string;
}

export interface ResolveProjectByUrlDeps {
  projectRepo: ProjectRepo;
  pageRepo: PageRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class ResolveProjectByUrl {
  constructor(private readonly deps: ResolveProjectByUrlDeps) {}

  async execute(
    input: ResolveProjectByUrlInput,
  ): Promise<Result<ResolveProjectByUrlOutput, DomainError>> {
    const { projectRepo, pageRepo, teamMemberRepo } = this.deps;

    const trimmed = input.url.trim();
    if (trimmed.length === 0) {
      return err(new Validation('Query parameter `url` is required.'));
    }

    // 1. Exact-match lookup against the `pages` table — this is the
    //    canonical resolution path established by Phase 23 (pages-as-
    //    first-class-entity). May return rows from multiple projects.
    const exactPages = await pageRepo.findAllByUrl(trimmed);
    for (const page of exactPages) {
      const project = await projectRepo.findById(page.projectId);
      if (!project) continue;
      const allowed = await hasProjectAccess(
        teamMemberRepo,
        project.ownerId,
        project.teamId,
        input.userId,
      );
      if (allowed) {
        return ok({ projectId: project.id, pageId: page.id });
      }
    }

    // 2. Prefix-match fallback against `Project.urls[]`. A project URL
    //    like `https://example.com` matches any host page whose URL
    //    begins with that prefix even when no `pages` row was seeded.
    //    The fallback exists for backwards-compat with legacy projects
    //    that predate the pages migration; once every project has a
    //    `pages` row the loop above wins outright.
    const accessible = await projectRepo.search({ userId: input.userId });
    const target = parseUrl(trimmed);
    for (const project of accessible) {
      for (const projectUrl of project.urls) {
        if (urlMatchesPrefix(target, projectUrl)) {
          // Try to surface a real Page id for the project + URL when one
          // exists; fall back to the project's first page so the inbound
          // adapter can still seed the extension overlay.
          const page = await pageRepo.findByProjectAndUrl(project.id, trimmed);
          if (page) {
            return ok({ projectId: project.id, pageId: page.id });
          }
          const pages = await pageRepo.listByProject(project.id);
          if (pages.length > 0) {
            return ok({ projectId: project.id, pageId: pages[0]!.id });
          }
        }
      }
    }

    return err(
      new NotFound('No accessible project found for the supplied URL.'),
    );
  }
}

interface ParsedUrl {
  host: string;
  pathname: string;
}

function parseUrl(raw: string): ParsedUrl | null {
  try {
    const u = new URL(raw);
    return { host: u.host.toLowerCase(), pathname: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Match a parsed page URL against a Project URL prefix. The Project URL
 * is the value the user entered when creating the project — typically a
 * bare host (`https://example.com`) or a host + path prefix
 * (`https://example.com/app`). Match rules:
 *   - hosts must be equal (case-insensitive)
 *   - the page pathname must equal or begin with the project pathname
 *     (with `/` treated as the universal prefix)
 */
function urlMatchesPrefix(
  target: ParsedUrl | null,
  projectUrl: string,
): boolean {
  if (!target) return false;
  const project = parseUrl(projectUrl);
  if (!project) return false;
  if (target.host !== project.host) return false;
  if (project.pathname === '' || project.pathname === '/') return true;
  if (target.pathname === project.pathname) return true;
  return target.pathname.startsWith(`${project.pathname}/`);
}
