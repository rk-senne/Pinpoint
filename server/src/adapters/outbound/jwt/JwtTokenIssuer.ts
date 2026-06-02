// jsonwebtoken-backed TokenIssuer adapter (Phase 1.5 / task 4.8.6).
//
// Per the hexagonal architecture rules, this file is the ONLY place in
// the codebase that imports `jsonwebtoken`. Domain code depends on the
// `TokenIssuer` port; the composition root wires this adapter in.
//
// Issue / verify semantics:
//   - `/refresh` honors a 7-day grace window past `exp`.
//   - Access tokens have a 24h TTL and carry payload `{ userId, email }`.
//
// The `decodeIgnoreExpiration` method is the building block that lets
// the `refreshToken` use case apply the grace check itself (the port
// docstring spells this out). Signature is still enforced; only the
// `exp` claim is ignored.

import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';

import type {
  TokenIssuer,
  TokenPayload,
  VerifiedToken,
} from '../../../domain/auth/ports/TokenIssuer.js';

export interface JwtTokenIssuerConfig {
  /** HMAC secret (or asymmetric key) used to sign and verify tokens. */
  secret: Secret;
  /**
   * Access-token TTL. Accepts the same shape as
   * `SignOptions['expiresIn']` (e.g. `'24h'` or a number of seconds).
   * Defaults to `'24h'` to match the legacy `signToken` helper.
   */
  accessTtl?: SignOptions['expiresIn'];
  /**
   * Sliding refresh grace window in seconds. A token whose `exp` is in
   * the past by no more than this many seconds is still acceptable to
   * the refresh use case (Req 33.3 / task 24.3). Defaults to 7 days.
   */
  graceWindowSeconds?: number;
}

const DEFAULT_ACCESS_TTL: SignOptions['expiresIn'] = '24h';
const DEFAULT_GRACE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export class JwtTokenIssuer implements TokenIssuer {
  private readonly secret: Secret;
  private readonly accessTtl: SignOptions['expiresIn'];
  readonly graceWindowSeconds: number;

  constructor(config: JwtTokenIssuerConfig) {
    this.secret = config.secret;
    this.accessTtl = config.accessTtl ?? DEFAULT_ACCESS_TTL;
    this.graceWindowSeconds =
      config.graceWindowSeconds ?? DEFAULT_GRACE_WINDOW_SECONDS;
  }

  sign(payload: TokenPayload): string {
    return jwt.sign({ ...payload }, this.secret, { expiresIn: this.accessTtl });
  }

  verify(token: string): VerifiedToken {
    const decoded = jwt.verify(token, this.secret);
    return this.coercePayload(decoded);
  }

  decodeIgnoreExpiration(token: string): VerifiedToken {
    // `ignoreExpiration: true` still enforces the signature; only the
    // `exp` claim is skipped. The refresh use case applies the grace
    // check via `graceWindowSeconds` itself.
    const decoded = jwt.verify(token, this.secret, { ignoreExpiration: true });
    return this.coercePayload(decoded);
  }

  /**
   * Narrow `jwt.verify`'s `string | JwtPayload` return type to a
   * `VerifiedToken`. A string return means the JWT had a non-object
   * payload, which we never sign here, so we treat it as malformed.
   */
  private coercePayload(decoded: jwt.JwtPayload | string): VerifiedToken {
    if (typeof decoded === 'string') {
      throw new jwt.JsonWebTokenError('Token payload was a string, expected a structured claim set.');
    }

    const userId = typeof decoded.userId === 'string' ? decoded.userId : null;
    const email = typeof decoded.email === 'string' ? decoded.email : null;
    const orgId = typeof decoded.orgId === 'string' ? decoded.orgId : null;
    const role = typeof decoded.role === 'string' ? decoded.role : null;
    const tokenVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : null;
    const exp = typeof decoded.exp === 'number' ? decoded.exp : null;

    if (userId === null || email === null || orgId === null || role === null || tokenVersion === null || exp === null) {
      throw new jwt.JsonWebTokenError('Token payload is missing required claims.');
    }

    return { userId, email, orgId, role, tokenVersion, exp };
  }
}
