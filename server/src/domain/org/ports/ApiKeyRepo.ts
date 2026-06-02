export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface NewApiKey {
  orgId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string;
}

export interface ApiKeyRepo {
  insert(input: NewApiKey): Promise<ApiKey>;
  findByHash(keyHash: string): Promise<ApiKey | null>;
  listByOrg(orgId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
}
