// Short-lived, signed access grant for password-protected shared links.
//
// `POST /shared/:linkId/verify` issues this after a correct password; the
// read endpoint `GET /shared/:linkId/annotations` requires it. The grant is
// an HMAC over (linkId, expiry, password fingerprint):
//   - bound to ONE link — a grant for link A is useless on link B;
//   - expires after SHARED_LINK_ACCESS_TTL_SECONDS;
//   - dies when the owner changes/removes the password (fingerprint changes);
//   - the key is derived from the server secret with a domain-separation
//     label, so it can never be confused with a session JWT.
// Delivered as an HttpOnly cookie whose Path is scoped to the link.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

export const SHARED_LINK_ACCESS_COOKIE = 'fl_shared_access';
export const SHARED_LINK_ACCESS_TTL_SECONDS = 30 * 60;

export interface SharedLinkAccessSigner {
  issue(linkId: string, passwordHash: string | null | undefined): { token: string; maxAgeSeconds: number };
  verify(token: string | undefined, linkId: string, passwordHash: string | null | undefined): boolean;
}

function fingerprint(passwordHash: string | null | undefined): string {
  return createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);
}

export function createSharedLinkAccessSigner(
  secret: string,
  now: () => number = () => Date.now(),
): SharedLinkAccessSigner {
  const key = createHmac('sha256', secret).update('pinpoint:shared-link-access:v1').digest();
  const sign = (linkId: string, exp: number, fp: string): string =>
    createHmac('sha256', key).update(`${linkId}\n${exp}\n${fp}`).digest('base64url');

  return {
    issue(linkId, passwordHash) {
      const exp = Math.floor(now() / 1000) + SHARED_LINK_ACCESS_TTL_SECONDS;
      return {
        token: `${exp}.${sign(linkId, exp, fingerprint(passwordHash))}`,
        maxAgeSeconds: SHARED_LINK_ACCESS_TTL_SECONDS,
      };
    },
    verify(token, linkId, passwordHash) {
      if (!token) return false;
      const dot = token.indexOf('.');
      if (dot < 1) return false;
      const exp = Number(token.slice(0, dot));
      if (!Number.isInteger(exp) || exp * 1000 <= now()) return false;
      const given = Buffer.from(token.slice(dot + 1));
      const expected = Buffer.from(sign(linkId, exp, fingerprint(passwordHash)));
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}

/** Read one cookie from the raw header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSharedLinkAccessCookie(
  res: Response,
  linkId: string,
  token: string,
  maxAgeSeconds: number,
  cookieInsecure: boolean,
): void {
  res.cookie(SHARED_LINK_ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !cookieInsecure,
    path: `/api/v1/shared/${encodeURIComponent(linkId)}`,
    maxAge: maxAgeSeconds * 1000,
  });
}
