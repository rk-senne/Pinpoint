// FakeProjectRepo — in-memory ProjectRepo fake (Phase 1.5 / task 4.11.1).
//
// Implements every method on the port, including the cross-aggregate
// `search` (filtered by ownership or team membership) and `listMembers`
// (team-member join + owner-prepend). Cross-aggregate queries delegate
// to the supplied `TeamMemberRepo` / `UserRepo` / `AnnotationRepo` fakes
// so behavior stays consistent when use-case tests wire all the fakes
// together via the same instances.

import { randomUUID } from 'node:crypto';

import type {
  NewProject,
  Project,
  ProjectPatch,
} from '../../domain/project/Project.js';
import type {
  ProjectMember,
  ProjectRepo,
  SearchProjectsInput,
} from '../../domain/project/ports/ProjectRepo.js';
import type { AnnotationRepo } from '../../domain/annotation/ports/AnnotationRepo.js';
import type { TeamMemberRepo } from '../../domain/team/ports/TeamMemberRepo.js';
import type { UserRepo } from '../../domain/user/ports/UserRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export interface FakeProjectRepoDeps {
  clock: Clock;
  /**
   * Optional. When supplied, `search()` filters by team membership; when
   * absent, only ownership matches.
   */
  teamMemberRepo?: TeamMemberRepo;
  /**
   * Optional. When supplied, `listMembers` joins team membership through
   * the user repo to produce email/name/avatar fields.
   */
  userRepo?: UserRepo;
  /**
   * Optional. When supplied, `countAnnotations` reflects the live
   * annotation list; otherwise it returns 0.
   */
  annotationRepo?: AnnotationRepo;
}

export class FakeProjectRepo implements ProjectRepo {
  /** Public for direct inspection in tests; key → row. */
  readonly projects = new Map<string, Project>();

  constructor(private readonly deps: FakeProjectRepoDeps) {}

  async insert(input: NewProject): Promise<Project> {
    const id = randomUUID();
    const now = this.deps.clock.now().toISOString();
    const project: Project = {
      id,
      name: input.name,
      urls: [...input.urls],
      status: 'active',
      ownerId: input.ownerId,
      createdAt: now,
      updatedAt: now,
    };
    if (input.teamId) project.teamId = input.teamId;
    this.projects.set(id, project);
    return { ...project, urls: [...project.urls] };
  }

  async findById(id: string): Promise<Project | null> {
    const row = this.projects.get(id);
    return row ? { ...row, urls: [...row.urls] } : null;
  }

  async search(input: SearchProjectsInput): Promise<Project[]> {
    const teamRepo = this.deps.teamMemberRepo;
    const memberships = teamRepo
      ? new Set(
          (await this.collectMemberships(teamRepo, input.userId)).map(
            (teamId) => teamId,
          ),
        )
      : new Set<string>();

    const search = input.search?.trim().toLowerCase() ?? '';

    const matching: Project[] = [];
    for (const project of this.projects.values()) {
      const accessible =
        project.ownerId === input.userId ||
        (project.teamId !== undefined && memberships.has(project.teamId));
      if (!accessible) continue;
      if (input.status && project.status !== input.status) continue;
      if (search.length > 0 && !project.name.toLowerCase().includes(search)) continue;
      matching.push({ ...project, urls: [...project.urls] });
    }

    matching.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return matching;
  }

  async update(id: string, patch: ProjectPatch): Promise<Project> {
    const row = this.projects.get(id);
    if (!row) throw new Error(`FakeProjectRepo.update: project ${id} not found`);
    const next: Project = {
      ...row,
      urls: [...row.urls],
      updatedAt: this.deps.clock.now().toISOString(),
    };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.status !== undefined) next.status = patch.status;
    this.projects.set(id, next);
    return { ...next, urls: [...next.urls] };
  }

  async delete(id: string): Promise<void> {
    this.projects.delete(id);
  }

  async countAnnotations(projectId: string): Promise<number> {
    if (!this.deps.annotationRepo) return 0;
    const list = await this.deps.annotationRepo.listByProject(projectId);
    return list.length;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const project = this.projects.get(projectId);
    if (!project) return [];

    const userRepo = this.deps.userRepo;
    const teamRepo = this.deps.teamMemberRepo;

    const seen = new Set<string>();
    const members: ProjectMember[] = [];

    if (project.teamId && teamRepo && userRepo) {
      const teamMembers = await teamRepo.listByTeam(project.teamId);
      for (const tm of teamMembers) {
        if (seen.has(tm.userId)) continue;
        const user = await userRepo.findById(tm.userId);
        if (!user) continue;
        seen.add(tm.userId);
        const member: ProjectMember = {
          userId: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl ?? null,
          role: tm.role,
          joinedAt: tm.joinedAt,
        };
        members.push(member);
      }
    }

    if (!seen.has(project.ownerId) && userRepo) {
      const owner = await userRepo.findById(project.ownerId);
      if (owner) {
        members.unshift({
          userId: owner.id,
          email: owner.email,
          name: owner.name,
          avatarUrl: owner.avatarUrl ?? null,
          role: 'owner',
        });
      }
    }

    return members;
  }

  private async collectMemberships(
    teamRepo: TeamMemberRepo,
    userId: string,
  ): Promise<string[]> {
    // The TeamMemberRepo port doesn't expose a "list teams I'm in" lookup,
    // so iterate every project's team and check membership. This is fine
    // for unit tests; production paths use the SQL adapter.
    const teamIds = new Set<string>();
    for (const project of this.projects.values()) {
      if (!project.teamId) continue;
      teamIds.add(project.teamId);
    }

    const accessible: string[] = [];
    for (const teamId of teamIds) {
      const membership = await teamRepo.findByTeamAndUser(teamId, userId);
      if (membership) accessible.push(teamId);
    }
    return accessible;
  }
}
