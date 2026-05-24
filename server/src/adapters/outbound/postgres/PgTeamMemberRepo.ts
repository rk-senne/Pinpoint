// Postgres adapter for TeamMemberRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { TeamMember, TeamRole } from '../../../domain/team/TeamMember.js';
import type {
  TeamMemberRepo,
  TeamMemberWithUser,
} from '../../../domain/team/ports/TeamMemberRepo.js';

interface TeamMemberRow {
  user_id: string;
  team_id: string;
  role: string;
  joined_at: Date | string;
}

interface TeamMemberJoinUserRow extends TeamMemberRow {
  email: string;
  name: string;
}

export class PgTeamMemberRepo implements TeamMemberRepo {
  constructor(private readonly db: Knex) {}

  async add(member: { teamId: string; userId: string; role: TeamRole }): Promise<TeamMember> {
    const [created] = await this.db<TeamMemberRow>('team_members')
      .insert({
        user_id: member.userId,
        team_id: member.teamId,
        role: member.role,
      })
      .returning(['user_id', 'team_id', 'role', 'joined_at']);
    return this.mapRow(created);
  }

  async remove(teamId: string, userId: string): Promise<void> {
    await this.db('team_members').where({ team_id: teamId, user_id: userId }).del();
  }

  async updateRole(teamId: string, userId: string, role: TeamRole): Promise<TeamMember> {
    const [updated] = await this.db<TeamMemberRow>('team_members')
      .where({ team_id: teamId, user_id: userId })
      .update({ role })
      .returning(['user_id', 'team_id', 'role', 'joined_at']);
    return this.mapRow(updated);
  }

  async findByTeamAndUser(teamId: string, userId: string): Promise<TeamMember | null> {
    const row = await this.db<TeamMemberRow>('team_members')
      .where({ team_id: teamId, user_id: userId })
      .first();
    return row ? this.mapRow(row) : null;
  }

  async listByTeam(teamId: string): Promise<TeamMemberWithUser[]> {
    const rows = await this.db('team_members')
      .join('users', 'team_members.user_id', 'users.id')
      .where('team_members.team_id', teamId)
      .select(
        'team_members.team_id',
        'team_members.user_id',
        'team_members.role',
        'team_members.joined_at',
        'users.email',
        'users.name',
      );
    return (rows as TeamMemberJoinUserRow[]).map((r) => this.mapJoinRow(r));
  }

  async listByTeams(teamIds: string[]): Promise<TeamMemberWithUser[]> {
    if (teamIds.length === 0) return [];
    const rows = await this.db('team_members')
      .join('users', 'team_members.user_id', 'users.id')
      .whereIn('team_members.team_id', teamIds)
      .select(
        'team_members.team_id',
        'team_members.user_id',
        'team_members.role',
        'team_members.joined_at',
        'users.email',
        'users.name',
      );
    return (rows as TeamMemberJoinUserRow[]).map((r) => this.mapJoinRow(r));
  }

  private mapRow(row: TeamMemberRow): TeamMember {
    return {
      userId: row.user_id,
      teamId: row.team_id,
      role: row.role as TeamRole,
      joinedAt: toIso(row.joined_at),
    };
  }

  private mapJoinRow(row: TeamMemberJoinUserRow): TeamMemberWithUser {
    return {
      ...this.mapRow(row),
      email: row.email,
      name: row.name,
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
