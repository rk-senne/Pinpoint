// FakeApiKeyRepo — in-memory ApiKeyRepo fake (Mission A1).

import { randomUUID } from 'node:crypto';

import type {
  ApiKey,
  ApiKeyRepo,
  NewApiKey,
} from '../../domain/org/ports/ApiKeyRepo.js';

export class FakeApiKeyRepo implements ApiKeyRepo {
  /** Public for direct inspection in tests, keyed by key hash. */
  readonly byHash = new Map<string, ApiKey>();
  readonly updatedLastUsed: string[] = [];

  async insert(input: NewApiKey): Promise<ApiKey> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const key: ApiKey = {
      id,
      orgId: input.orgId,
      name: input.name,
      keyPrefix: input.keyPrefix,
      scopes: [...input.scopes],
      createdBy: input.createdBy,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
      keyType: input.keyType ?? 'standard',
      projectId: input.projectId ?? null,
      allowedOrigins: input.allowedOrigins ? [...input.allowedOrigins] : [],
      dailyQuota: input.dailyQuota ?? null,
    };
    this.byHash.set(input.keyHash, key);
    return { ...key, scopes: [...key.scopes], allowedOrigins: [...key.allowedOrigins] };
  }

  /** Test helper: register a key under a specific hash. */
  seed(keyHash: string, key: ApiKey): void {
    this.byHash.set(keyHash, key);
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    const key = this.byHash.get(keyHash);
    if (!key || key.revokedAt) return null;
    return { ...key, scopes: [...key.scopes], allowedOrigins: [...key.allowedOrigins] };
  }

  async listByOrg(orgId: string): Promise<ApiKey[]> {
    return Array.from(this.byHash.values())
      .filter((k) => k.orgId === orgId)
      .map((k) => ({ ...k, scopes: [...k.scopes], allowedOrigins: [...k.allowedOrigins] }));
  }

  async revoke(id: string): Promise<void> {
    for (const key of this.byHash.values()) {
      if (key.id === id) key.revokedAt = new Date().toISOString();
    }
  }

  async updateLastUsed(id: string): Promise<void> {
    this.updatedLastUsed.push(id);
    for (const key of this.byHash.values()) {
      if (key.id === id) key.lastUsedAt = new Date().toISOString();
    }
  }
}
