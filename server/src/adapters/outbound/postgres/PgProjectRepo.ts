// Postgres adapter for ProjectRepo (Phase 1.5 / task 4.8.1).
//
// SQL implements the project read/write surface: search query with
// owner-or-team-membership, member listing with owner-prepended,
// annotation count.

import type { Knex } from 'knex';
import type {
  NewProject,
  Project,
  ProjectPatch,
  ProjectStatus,
} from '../../../domain/project/Project.js';
import type {
  ProjectMember,
  ProjectRepo,
  SearchProjectsInput,
} from '../../../domain/project/ports/ProjectRepo.js';

interface ProjectRow {
  id: string;
  name: string;
  urls: string[];
  status: string;
  owner_id: string;
  team_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MemberJoinRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: string;
  joined_at: Date | string;
}

export class PgProjectRepo implements ProjectRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewProject): Promise<Project> {
    const row: Record<string, unknown> = {
      name: input.name,
      urls: input.urls,
      status: 'active',
      owner_id: input.ownerId,
    };
    if (input.orgId) row.org_id = input.orgId;
    if (input.teamId) row.team_id = input.teamId;

    const [created] = await this.db<ProjectRow>('projects')
      .insert(row)
      .returning(['id', 'name', 'urls', 'status', 'owner_id', 'team_id', 'created_at', 'updated_at']);
    return this.mapRow(created);
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.db<ProjectRow>('projects').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async search(input: SearchProjectsInput): Promise<Project[]> {
    let query = this.db<ProjectRow>('projects')
      .select('projects.*')
      .where(function () {
        this.where('projects.owner_id', input.userId).orWhereIn(
          'projects.team_id',
          function () {
            this.select('team_id').from('team_members').where('user_id', input.userId);
          },
        );
      });

    if (input.status) {
      query = query.andWhere('projects.status', input.status);
    }

    if (input.search && input.search.trim().length > 0) {
      const needle = `%${input.search.toLowerCase()}%`;
      query = query.andWhereRaw('LOWER(projects.name) LIKE ?', [needle]);
    }

    const rows = await query.orderBy('projects.updated_at', 'desc');
    return rows.map((r) => this.mapRow(r));
  }

  async update(id: string, patch: ProjectPatch): Promise<Project> {
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.status !== undefined) updates.status = patch.status;

    const [updated] = await this.db<ProjectRow>('projects')
      .where({ id })
      .update(updates)
      .returning(['id', 'name', 'urls', 'status', 'owner_id', 'team_id', 'created_at', 'updated_at']);
    return this.mapRow(updated);
  }

  async delete(id: string): Promise<void> {
    await this.db('projects').where({ id }).del();
  }

  async countAnnotations(projectId: string): Promise<number> {
    const [{ count }] = await this.db('annotations')
      .where({ project_id: projectId })
      .count<[{ count: string | number }]>('id as count');
    return Number(count);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const project = await this.db<ProjectRow>('projects').where({ id: projectId }).first();
    if (!project) return [];

    let teamRows: MemberJoinRow[] = [];
    if (project.team_id) {
      teamRows = await this.db('team_members')
        .join('users', 'team_members.user_id', 'users.id')
        .where('team_members.team_id', project.team_id)
        .select(
          'users.id',
          'users.email',
          'users.name',
          'users.avatar_url',
          'team_members.role',
          'team_members.joined_at',
        );
    }

    const seen = new Set<string>();
    const members: ProjectMember[] = [];

    for (const r of teamRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      members.push(this.mapMember(r));
    }

    // Always surface the owner first when not already represented as a team
    // member with a different role.
    if (!seen.has(project.owner_id)) {
      const owner = await this.db('users').where({ id: project.owner_id }).first();
      if (owner) {
        members.unshift({
          userId: owner.id,
          email: owner.email,
          name: owner.name,
          avatarUrl: owner.avatar_url ?? null,
          role: 'owner',
        });
      }
    }

    return members;
  }

  private mapRow(row: ProjectRow): Project {
    const project: Project = {
      id: row.id,
      name: row.name,
      urls: row.urls ?? [],
      status: row.status as ProjectStatus,
      ownerId: row.owner_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
    if (row.team_id) project.teamId = row.team_id;
    return project;
  }

  private mapMember(row: MemberJoinRow): ProjectMember {
    const member: ProjectMember = {
      userId: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url ?? null,
      role: row.role as ProjectMember['role'],
    };
    if (row.joined_at) member.joinedAt = toIso(row.joined_at);
    return member;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
