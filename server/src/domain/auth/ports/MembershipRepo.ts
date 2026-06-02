// MembershipRepo port — provides org membership lookups for auth flows.

export interface Membership {
  orgId: string;
  userId: string;
  role: string;
}

export interface MembershipRepo {
  /** Find the user's first (default) org membership. Returns null if none. */
  findDefaultForUser(userId: string): Promise<Membership | null>;
  /** Find a specific user's membership in a specific org. */
  findByOrgAndUser(orgId: string, userId: string): Promise<Membership | null>;
  /** Create a new membership. */
  create(membership: Membership): Promise<void>;
  /** List all members of an org. */
  listByOrg(orgId: string): Promise<Membership[]>;
  /** Remove a membership. */
  removeByOrgAndUser(orgId: string, userId: string): Promise<void>;
  /** Update a member's role. */
  updateRole(orgId: string, userId: string, role: string): Promise<void>;
}
