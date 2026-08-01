export interface Integration {
  id: string;
  orgId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

export interface IntegrationRepo {
  findByOrgAndProvider(orgId: string, provider: string): Promise<Integration | null>;
  listByOrg(orgId: string): Promise<Integration[]>;
  upsert(orgId: string, provider: string, data: Partial<Integration>): Promise<Integration>;
  delete(orgId: string, provider: string): Promise<boolean>;
}
