// FakeTeamMemberRepo — in-memory TeamMemberRepo fake
// (Phase 1.5 / task 4.11.1).
//
// `listByTeam` / `listByTeams` join through the optional `UserRepo` so
// the produced rows include the user's email + name. Without a user repo,
// the joined fields fall back to empty strings — the join is the only
// place the port exposes user data, so most tests will wire both fakes.

import type { TeamMember, TeamRole } from '../../domain/team/TeamMember.js';
import type {
  TeamMemberRepo,
  TeamMemberWithUser,
} from '../../domain/team/ports/TeamMemberRepo.js';
import type { UserRepo } from '../../domain/user/ports/UserRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export interface FakeTeamMemberRepoDeps {
  clock: Clock;
  /**
   * Optional. When supplied, list calls join through the user repo so
   * `email` / `name` reflect the actual user.
   */
  userRepo?: UserRepo;
}

function memberKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

export class FakeTeamMemberRepo implements TeamMemberRepo {
  /** Public for direct inspection in tests; key = `${teamId}:${userId}`. */
  readonly members = new Map<string, TeamMember>();

  constructor(private readonly deps: FakeTeamMemberRepoDeps) {}

  async add(member: {
    teamId: string;
    userId: string;
    role: TeamRole;
  }): Promise<TeamMember> {
    const row: TeamMember = {
      teamId: member.teamId,
      userId: member.userId,
      role: member.role,
      joinedAt: this.deps.clock.now().toISOString(),
    };
    this.members.set(memberKey(member.teamId, member.userId), row);
    return { ...row };
  }

  async remove(teamId: string, userId: string): Promise<void> {
    this.members.delete(memberKey(teamId, userId));
  }

  async updateRole(
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMember> {
    const row = this.members.get(memberKey(teamId, userId));
    if (!row) {
      throw new Error(
        `FakeTeamMemberRepo.updateRole: team_member ${teamId}/${userId} not found`,
      );
    }
    const next: TeamMember = { ...row, role };
    this.members.set(memberKey(teamId, userId), next);
    return { ...next };
  }

  async findByTeamAndUser(
    teamId: string,
    userId: string,
  ): Promise<TeamMember | null> {
    const row = this.members.get(memberKey(teamId, userId));
    return row ? { ...row } : null;
  }

  async listByTeam(teamId: string): Promise<TeamMemberWithUser[]> {
    const matches: TeamMemberWithUser[] = [];
    for (const row of this.members.values()) {
      if (row.teamId !== teamId) continue;
      matches.push(await this.attachUser(row));
    }
    return matches;
  }

  async listByTeams(teamIds: string[]): Promise<TeamMemberWithUser[]> {
    if (teamIds.length === 0) return [];
    const wanted = new Set(teamIds);
    const matches: TeamMemberWithUser[] = [];
    for (const row of this.members.values()) {
      if (!wanted.has(row.teamId)) continue;
      matches.push(await this.attachUser(row));
    }
    return matches;
  }

  private async attachUser(row: TeamMember): Promise<TeamMemberWithUser> {
    const userRepo = this.deps.userRepo;
    if (!userRepo) {
      return { ...row, email: '', name: '' };
    }
    const user = await userRepo.findById(row.userId);
    return {
      ...row,
      email: user?.email ?? '',
      name: user?.name ?? '',
    };
  }
}
