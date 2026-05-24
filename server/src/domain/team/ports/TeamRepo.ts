// TeamRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewTeam, Team } from '../Team.js';

export interface TeamWithRole extends Team {
  /** The querying user's role in the team. */
  role: 'owner' | 'admin' | 'viewer';
}

export interface TeamRepo {
  insert(input: NewTeam): Promise<Team>;
  findById(id: string): Promise<Team | null>;
  /** Teams the user belongs to, with their role attached. */
  listForUser(userId: string): Promise<TeamWithRole[]>;
}
