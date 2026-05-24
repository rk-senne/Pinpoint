// AuthTokenRepo outbound port (Phase 1.5 / task 4.6.2).

import type { AuthToken, AuthTokenKind, NewAuthToken } from '../AuthToken.js';

export interface AuthTokenRepo {
  insert(input: NewAuthToken): Promise<AuthToken>;
  /** Lookup an unused, non-expired token by hash + kind. Returns null otherwise. */
  findValid(
    tokenHash: string,
    kind: AuthTokenKind,
    now: Date,
  ): Promise<AuthToken | null>;
  /** Mark a single token as used. */
  markUsed(id: string): Promise<void>;
  /** Mark all unused tokens of a given kind for a user as used (cleanup). */
  markAllUsedForUser(userId: string, kind: AuthTokenKind): Promise<void>;
}
