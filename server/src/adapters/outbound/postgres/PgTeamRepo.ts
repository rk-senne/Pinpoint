// Postgres adapter for TeamRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { NewTeam, Team } from '../../../domain/team/Team.js';
import type { TeamRepo, TeamWithRole } from '../../../domain/team/ports/TeamRepo.js';

interface TeamRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date | string;
}

interface TeamJoinRoleRow extends TeamRow {
  role: string;
}

export class PgTeamRepo implements TeamRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewTeam): Promise<Team> {
    const [created] = await this.db<TeamRow>('teams')
      .insert({ name: input.name, owner_id: input.ownerId })
      .returning(['id', 'name', 'owner_id', 'created_at']);
    return this.mapRow(created);
  }

  async findById(id: string): Promise<Team | null> {
    const row = await this.db<TeamRow>('teams').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async listForUser(userId: string): Promise<TeamWithRole[]> {
    const rows = await this.db('teams')
      .join('team_members', 'teams.id', 'team_members.team_id')
      .where('team_members.user_id', userId)
      .select(
        'teams.id',
        'teams.name',
        'teams.owner_id',
        'teams.created_at',
        'team_members.role',
      )
      .orderBy('teams.created_at', 'desc');

    return (rows as TeamJoinRoleRow[]).map((r) => ({
      ...this.mapRow(r),
      role: r.role as TeamWithRole['role'],
    }));
  }

  private mapRow(row: TeamRow): Team {
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      createdAt: toIso(row.created_at),
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
