export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

export interface NewInvitation {
  orgId: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
}

export interface InvitationRepo {
  insert(input: NewInvitation): Promise<Invitation>;
  findByToken(token: string): Promise<Invitation | null>;
  deleteById(id: string): Promise<void>;
  findByOrgAndEmail(orgId: string, email: string): Promise<Invitation | null>;
}
