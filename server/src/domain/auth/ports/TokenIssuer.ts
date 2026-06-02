// TokenIssuer outbound port (Phase 1.5 / task 4.6.2).
//
// Issues and verifies session JWTs (Req 18.6, 33.3). The JWT adapter is
// the only file in the codebase that imports `jsonwebtoken`.

export interface TokenPayload {
  userId: string;
  email: string;
  orgId: string;
  role: string;
  tokenVersion: number;
}

/** Decoded payload as returned by `verify` / `decodeIgnoreExpiration`. */
export interface VerifiedToken extends TokenPayload {
  /** Seconds since epoch — matches the JWT `exp` claim. */
  exp: number;
}

export interface TokenIssuer {
  /** Sign a fresh session JWT with the configured TTL. */
  sign(payload: TokenPayload): string;

  /** Verify signature + expiry; throws when invalid. */
  verify(token: string): VerifiedToken;

  /**
   * Verify signature only and return the decoded payload even when
   * expired. Used by `refreshToken` so the use case can apply the
   * grace-window check itself.
   */
  decodeIgnoreExpiration(token: string): VerifiedToken;

  /** Configured grace window in seconds (Req 33.3 — sliding refresh). */
  readonly graceWindowSeconds: number;
}
