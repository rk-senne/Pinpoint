// refreshToken use case (Phase 1.5 / task 4.7.1).
//
// Hex extraction of `POST /api/v1/auth/refresh` (task 24.3 / Req 33.3).
// Implements the sliding-window JWT refresh:
//
//   - Accepts a token that is either still valid OR expired by no more
//     than `tokenIssuer.graceWindowSeconds` seconds past `exp`.
//   - Verifies the signature even when the token is expired (via
//     `decodeIgnoreExpiration`) so we can apply the grace check
//     ourselves rather than letting the JWT library reject it first.
//   - On success mints a fresh access token plus a new CSRF nonce. The
//     inbound adapter decides whether to re-issue cookies (dashboard
//     path) or only return the body bearer (extension path).
//
// The whole grace-window check is expressed in seconds so we use the
// `Clock` port consistently with the JWT `exp` claim's representation.

import { randomBytes } from 'node:crypto';
import { Unauthorized, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { TokenIssuer } from '../ports/TokenIssuer.js';

export interface RefreshTokenInput {
  /** Raw JWT extracted from `Authorization: Bearer ...` or `fl_session` cookie. */
  token: string;
}

export interface RefreshTokenOutput {
  /** Newly minted JWT access token. */
  token: string;
  /** Fresh CSRF nonce to pair with the new `fl_csrf` cookie when applicable. */
  csrfToken: string;
}

export interface RefreshTokenDeps {
  tokenIssuer: TokenIssuer;
  clock: Clock;
}

export class RefreshToken {
  constructor(private readonly deps: RefreshTokenDeps) {}

  async execute(
    input: RefreshTokenInput,
  ): Promise<Result<RefreshTokenOutput, DomainError>> {
    const { tokenIssuer, clock } = this.deps;

    const invalid = (): Result<RefreshTokenOutput, DomainError> =>
      err(
        new Unauthorized(
          'Token is invalid or has expired beyond the refresh grace window.',
        ),
      );

    if (typeof input.token !== 'string' || input.token.length === 0) {
      return invalid();
    }

    let payload;
    try {
      payload = tokenIssuer.decodeIgnoreExpiration(input.token);
    } catch {
      return invalid();
    }

    if (
      typeof payload.userId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return invalid();
    }

    // `exp` is seconds-since-epoch per RFC 7519. Compare against the
    // injected clock in seconds so domain code stays unit-consistent
    // with the JWT spec.
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    const ageSeconds = nowSeconds - payload.exp;
    if (ageSeconds > tokenIssuer.graceWindowSeconds) {
      return invalid();
    }

    const token = tokenIssuer.sign({
      userId: payload.userId,
      email: payload.email,
    });
    const csrfToken = randomBytes(32).toString('hex');

    return ok({ token, csrfToken });
  }
}
