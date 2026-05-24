// Team entity (Phase 1.5 / task 4.6.1).

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface NewTeam {
  name: string;
  ownerId: string;
}
