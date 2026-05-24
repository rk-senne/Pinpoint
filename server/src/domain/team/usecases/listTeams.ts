// listTeams use case (Phase 1.5 / task 4.7.5).
//
// Implements `GET /api/v1/teams`. Returns every Team the caller belongs
// to, each enriched with the caller's `role` and a flat `members`
// array (joined with the users table) so
// the dashboard team-management view (Reqs 9.1, 9.3, 9.5) can render
// everything in one round-trip.

import type { Team } from '../Team.js';
import type { TeamRole } from '../TeamMember.js';
import type { TeamRepo } from '../ports/TeamRepo.js';
import type { TeamMemberRepo } from '../ports/TeamMemberRepo.js';
import {
  type DomainError,
  type Result,
  ok,
} from '../../shared/DomainError.js';

export interface TeamWithMembers extends Team {
  /** Caller's role in the team. */
  role: TeamRole;
  members: Array<{
    userId: string;
    role: TeamRole;
    email: string;
    name: string;
  }>;
}

export interface ListTeamsInput {
  /** Caller's user id. */
  userId: string;
}

export interface ListTeamsOutput {
  teams: TeamWithMembers[];
}

export interface ListTeamsDeps {
  teamRepo: TeamRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class ListTeams {
  constructor(private readonly deps: ListTeamsDeps) {}

  async execute(
    input: ListTeamsInput,
  ): Promise<Result<ListTeamsOutput, DomainError>> {
    const { teamRepo, teamMemberRepo } = this.deps;

    const teams = await teamRepo.listForUser(input.userId);
    const teamIds = teams.map((t) => t.id);

    // One bulk read pulls every membership row across the user's teams;
    // we partition in memory to avoid the N+1 SELECT pattern the legacy
    // route was carrying.
    const memberRows = await teamMemberRepo.listByTeams(teamIds);
    const byTeam = new Map<string, TeamWithMembers['members']>();
    for (const row of memberRows) {
      const list = byTeam.get(row.teamId) ?? [];
      list.push({
        userId: row.userId,
        role: row.role,
        email: row.email,
        name: row.name,
      });
      byTeam.set(row.teamId, list);
    }

    const enriched: TeamWithMembers[] = teams.map((t) => ({
      id: t.id,
      name: t.name,
      ownerId: t.ownerId,
      createdAt: t.createdAt,
      role: t.role,
      members: byTeam.get(t.id) ?? [],
    }));

    return ok({ teams: enriched });
  }
}
