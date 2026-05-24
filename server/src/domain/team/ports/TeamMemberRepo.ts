// TeamMemberRepo outbound port (Phase 1.5 / task 4.6.2).

import type { TeamMember, TeamRole } from '../TeamMember.js';

/** Join row used by the dashboard team-management UI. */
export interface TeamMemberWithUser extends TeamMember {
  email: string;
  name: string;
}

export interface TeamMemberRepo {
  add(member: { teamId: string; userId: string; role: TeamRole }): Promise<TeamMember>;
  remove(teamId: string, userId: string): Promise<void>;
  updateRole(teamId: string, userId: string, role: TeamRole): Promise<TeamMember>;
  findByTeamAndUser(teamId: string, userId: string): Promise<TeamMember | null>;
  /** All members of a team joined with the users table. */
  listByTeam(teamId: string): Promise<TeamMemberWithUser[]>;
  /** All members across multiple teams; used by the listTeams use case. */
  listByTeams(teamIds: string[]): Promise<TeamMemberWithUser[]>;
}
