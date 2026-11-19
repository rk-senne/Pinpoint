export type ApiKeyType = 'standard' | 'widget';

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
  /** 'standard' for Bearer API keys, 'widget' for project-bound pk_widget_ keys. */
  keyType: ApiKeyType;
  /** Target project for widget keys; null for standard keys. */
  projectId: string | null;
  /** Origins the widget CORS layer may reflect. Empty = any origin (never credentials). */
  allowedOrigins: string[];
  /** Max widget submissions per UTC day; null = unlimited. */
  dailyQuota: number | null;
}

export interface NewApiKey {
  orgId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string;
  /** Defaults to 'standard' when omitted. */
  keyType?: ApiKeyType;
  /** Required for widget keys; ignored for standard keys. */
  projectId?: string | null;
  /** Origins the widget CORS layer may reflect. Defaults to empty (any origin). */
  allowedOrigins?: string[];
  /** Per-key daily submission quota; null/omitted = unlimited. */
  dailyQuota?: number | null;
}

export interface ApiKeyRepo {
  insert(input: NewApiKey): Promise<ApiKey>;
  findByHash(keyHash: string): Promise<ApiKey | null>;
  listByOrg(orgId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
}
