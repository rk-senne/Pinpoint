// FakeTeamRepo — in-memory TeamRepo fake (Phase 1.5 / task 4.11.1).
//
// `listForUser` joins through the supplied `TeamMemberRepo` so the
// member→team relationship stays consistent across fakes wired into the
// same use-case test.

import { randomUUID } from 'node:crypto';

import type { NewTeam, Team } from '../../domain/team/Team.js';
import type { TeamRepo, TeamWithRole } from '../../domain/team/ports/TeamRepo.js';
import type { TeamMemberRepo } from '../../domain/team/ports/TeamMemberRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export interface FakeTeamRepoDeps {
  clock: Clock;
  /**
   * Optional. When supplied, `listForUser` joins through the member repo
   * to attach roles; otherwise it returns owner-only teams with role
   * `'owner'` for the matching user.
   */
  teamMemberRepo?: TeamMemberRepo;
}

export class FakeTeamRepo implements TeamRepo {
  /** Public for direct inspection in tests. */
  readonly teams = new Map<string, Team>();

  constructor(private readonly deps: FakeTeamRepoDeps) {}

  async insert(input: NewTeam): Promise<Team> {
    const id = randomUUID();
    const team: Team = {
      id,
      name: input.name,
      ownerId: input.ownerId,
      createdAt: this.deps.clock.now().toISOString(),
    };
    this.teams.set(id, team);
    return { ...team };
  }

  async findById(id: string): Promise<Team | null> {
    const row = this.teams.get(id);
    return row ? { ...row } : null;
  }

  async listForUser(userId: string): Promise<TeamWithRole[]> {
    const teamRepo = this.deps.teamMemberRepo;
    const matches: TeamWithRole[] = [];

    for (const team of this.teams.values()) {
      let role: TeamWithRole['role'] | null = null;
      if (teamRepo) {
        const membership = await teamRepo.findByTeamAndUser(team.id, userId);
        if (membership) role = membership.role;
      } else if (team.ownerId === userId) {
        role = 'owner';
      }
      if (role) matches.push({ ...team, role });
    }

    matches.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return matches;
  }
}
