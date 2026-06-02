// FakeTokenIssuer — deterministic TokenIssuer fake (Phase 1.5 /
// task 4.11.1).
//
// `sign(payload)` returns a JSON-encoded string `{ ...claims, exp }`
// where `exp` is `clock.now() + accessTtlSeconds` (defaulting to 24 h to
// match the production adapter). `verify` decodes the JSON and rejects
// expired or malformed tokens; `decodeIgnoreExpiration` skips the expiry
// check so the refresh use case can apply its own grace check.
//
// `graceWindowSeconds` defaults to 7 days, matching JwtTokenIssuer.

import type { Clock } from '../../domain/shared/ports/Clock.js';
import type {
  TokenIssuer,
  TokenPayload,
  VerifiedToken,
} from '../../domain/auth/ports/TokenIssuer.js';

export interface FakeTokenIssuerOptions {
  /** Access-token TTL in seconds. Defaults to 24 hours. */
  accessTtlSeconds?: number;
  /** Sliding refresh window in seconds. Defaults to 7 days. */
  graceWindowSeconds?: number;
}

const DEFAULT_ACCESS_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_GRACE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export class FakeTokenIssuer implements TokenIssuer {
  private readonly accessTtlSeconds: number;
  readonly graceWindowSeconds: number;

  constructor(
    private readonly clock: Clock,
    options: FakeTokenIssuerOptions = {},
  ) {
    this.accessTtlSeconds = options.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.graceWindowSeconds =
      options.graceWindowSeconds ?? DEFAULT_GRACE_WINDOW_SECONDS;
  }

  sign(payload: TokenPayload): string {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const exp = nowSeconds + this.accessTtlSeconds;
    return JSON.stringify({ ...payload, exp } satisfies VerifiedToken);
  }

  verify(token: string): VerifiedToken {
    const decoded = this.decode(token);
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    if (decoded.exp < nowSeconds) {
      throw new Error('FakeTokenIssuer: token expired');
    }
    return decoded;
  }

  decodeIgnoreExpiration(token: string): VerifiedToken {
    return this.decode(token);
  }

  private decode(token: string): VerifiedToken {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new Error('FakeTokenIssuer: malformed token');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { userId?: unknown }).userId !== 'string' ||
      typeof (parsed as { email?: unknown }).email !== 'string' ||
      typeof (parsed as { orgId?: unknown }).orgId !== 'string' ||
      typeof (parsed as { role?: unknown }).role !== 'string' ||
      typeof (parsed as { tokenVersion?: unknown }).tokenVersion !== 'number' ||
      typeof (parsed as { exp?: unknown }).exp !== 'number'
    ) {
      throw new Error('FakeTokenIssuer: missing required claims');
    }
    const claims = parsed as VerifiedToken;
    return {
      userId: claims.userId,
      email: claims.email,
      orgId: claims.orgId,
      role: claims.role,
      tokenVersion: claims.tokenVersion,
      exp: claims.exp,
    };
  }
}
