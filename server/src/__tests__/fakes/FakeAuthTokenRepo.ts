// FakeAuthTokenRepo — in-memory AuthTokenRepo fake
// (Phase 1.5 / task 4.11.1).
//
// Backs the rename from `password_resets` to `auth_tokens`. Tokens are
// stored by id and looked up by `(tokenHash, kind)` with the
// non-expired + unused filter applied in memory.

import { randomUUID } from 'node:crypto';

import type {
  AuthToken,
  AuthTokenKind,
  NewAuthToken,
} from '../../domain/auth/AuthToken.js';
import type { AuthTokenRepo } from '../../domain/auth/ports/AuthTokenRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakeAuthTokenRepo implements AuthTokenRepo {
  /** Public for direct inspection in tests. */
  readonly tokens = new Map<string, AuthToken>();

  constructor(private readonly clock: Clock) {}

  async insert(input: NewAuthToken): Promise<AuthToken> {
    const id = randomUUID();
    const token: AuthToken = {
      id,
      userId: input.userId,
      kind: input.kind,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      used: false,
      createdAt: this.clock.now().toISOString(),
    };
    this.tokens.set(id, token);
    return { ...token };
  }

  async findValid(
    tokenHash: string,
    kind: AuthTokenKind,
    now: Date,
  ): Promise<AuthToken | null> {
    for (const token of this.tokens.values()) {
      if (token.tokenHash !== tokenHash) continue;
      if (token.kind !== kind) continue;
      if (token.used) continue;
      if (new Date(token.expiresAt).getTime() <= now.getTime()) continue;
      return { ...token };
    }
    return null;
  }

  async markUsed(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (!token) return;
    this.tokens.set(id, { ...token, used: true });
  }

  async markAllUsedForUser(userId: string, kind: AuthTokenKind): Promise<void> {
    for (const [id, token] of this.tokens.entries()) {
      if (token.userId !== userId || token.kind !== kind || token.used) continue;
      this.tokens.set(id, { ...token, used: true });
    }
  }
}
