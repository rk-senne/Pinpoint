// standard-webhooks signing (Mission A5b).
//
// Implements the Standard Webhooks spec (https://www.standardwebhooks.com)
// so consumers can verify Pinpoint deliveries with any off-the-shelf
// standard-webhooks library. We intentionally do NOT pull a new dependency:
// the spec's signing scheme is a small, well-defined HMAC-SHA256 construction
// and reimplementing it keeps the webhook domain free of a third-party
// package whose surface we'd otherwise have to pin and audit.
//
// Signing scheme:
//   secret      — a base64 value carried after the `whsec_` prefix.
//   signedData  — `${msgId}.${timestampSeconds}.${body}`
//   signature   — HMAC-SHA256(secretBytes, signedData), base64-encoded.
//   header      — `webhook-signature: v1,<base64>` (space-separated list of
//                 versioned signatures; we emit a single v1 entry).
//
// Emitted headers on every delivery:
//   webhook-id         — stable per-delivery message id (consumer dedupe key)
//   webhook-timestamp  — unix seconds the signature was computed at
//   webhook-signature  — `v1,<base64>`
//
// Legacy secrets (pre-A5b) were 64-char hex with no prefix and signed the raw
// body only. `parseSecret` accepts both shapes so existing endpoints keep
// working; `generateSecret` always mints a new `whsec_`-prefixed secret.

import crypto from 'node:crypto';

/** Prefix that marks a Standard Webhooks symmetric secret. */
export const WHSEC_PREFIX = 'whsec_';

export interface SignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * Generate a new signing secret in Standard Webhooks form: `whsec_` followed
 * by 32 random bytes, base64-encoded.
 */
export function generateSecret(): string {
  return WHSEC_PREFIX + crypto.randomBytes(32).toString('base64');
}

/** True when `secret` is a Standard Webhooks `whsec_`-prefixed secret. */
export function isWhsecSecret(secret: string): boolean {
  return secret.startsWith(WHSEC_PREFIX);
}

/**
 * Resolve the raw key bytes from a stored secret.
 *
 * `whsec_`-prefixed secrets: base64-decode the suffix (Standard Webhooks).
 * Legacy secrets (no prefix): use the UTF-8 bytes of the string directly,
 * matching how pre-A5b deliveries were signed (`createHmac('sha256', secret)`).
 */
export function secretKeyBytes(secret: string): Buffer {
  if (isWhsecSecret(secret)) {
    return Buffer.from(secret.slice(WHSEC_PREFIX.length), 'base64');
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * Compute the base64 signature of `${msgId}.${timestamp}.${body}`.
 * `timestamp` is unix seconds (not milliseconds) per the spec.
 */
export function computeSignature(
  secret: string,
  msgId: string,
  timestampSeconds: number,
  body: string,
): string {
  const toSign = `${msgId}.${timestampSeconds}.${body}`;
  return crypto.createHmac('sha256', secretKeyBytes(secret)).update(toSign).digest('base64');
}

/**
 * Build the three Standard Webhooks headers for a delivery.
 *
 * `msgId` is the stable per-delivery id (reused across retries so a consumer
 * can dedupe); `timestampSeconds` defaults to now.
 */
export function buildSignatureHeaders(
  secret: string,
  msgId: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): SignatureHeaders {
  const signature = computeSignature(secret, msgId, timestampSeconds, body);
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': `v1,${signature}`,
  };
}

/**
 * Constant-time verification of a `webhook-signature` header value (which may
 * carry several space-separated `v1,<sig>` entries). Returns true if any entry
 * matches. Exported primarily for tests and future inbound verification.
 */
export function verifySignature(
  secret: string,
  msgId: string,
  timestampSeconds: number,
  body: string,
  signatureHeader: string,
): boolean {
  const expected = computeSignature(secret, msgId, timestampSeconds, body);
  const expectedBuf = Buffer.from(expected, 'utf8');
  for (const part of signatureHeader.split(' ')) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    const candidate = part.slice(comma + 1);
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}
