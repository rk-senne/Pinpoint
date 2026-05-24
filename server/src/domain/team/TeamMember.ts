// TeamMember entity (Phase 1.5 / task 4.6.1).

export type TeamRole = 'owner' | 'admin' | 'viewer';

export interface TeamMember {
  userId: string;
  teamId: string;
  role: TeamRole;
  joinedAt: string;
}
