// Team entity (Phase 1.5 / task 4.6.1).

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  /** Owning organisation (PP-04). Always set for rows created after the org_id migration. */
  orgId?: string | null;
}

export interface NewTeam {
  name: string;
  ownerId: string;
  orgId?: string | null;
}
