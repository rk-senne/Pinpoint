// Webhook signature verification per provider (Task 4).
// Uses crypto.timingSafeEqual for constant-time comparison.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  provider: string,
  payload: string,
  signature: string,
  secret: string,
  timestamp?: string,
): boolean {
  try {
    switch (provider) {
      case 'slack': {
        // Slack: v0=HMAC-SHA256 of "v0:timestamp:body"
        const ts = timestamp ?? '';
        const baseString = `v0:${ts}:${payload}`;
        const expected = 'v0=' + createHmac('sha256', secret).update(baseString).digest('hex');
        return safeCompare(expected, signature);
      }
      case 'github': {
        // GitHub: sha256=HMAC-SHA256 of body
        const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
        return safeCompare(expected, signature);
      }
      case 'linear': {
        const expected = createHmac('sha256', secret).update(payload).digest('hex');
        return safeCompare(expected, signature);
      }
      case 'jira': {
        // Atlassian Connect: HMAC-SHA256 of body
        const expected = createHmac('sha256', secret).update(payload).digest('hex');
        return safeCompare(expected, signature);
      }
      case 'stripe': {
        // Stripe verification is delegated to the Stripe SDK in billing.
        // This is a fallback that validates the signature header format:
        // t=timestamp,v1=signature
        const parts = signature.split(',');
        const tPart = parts.find((p) => p.startsWith('t='));
        const v1Part = parts.find((p) => p.startsWith('v1='));
        if (!tPart || !v1Part) return false;
        const ts = tPart.slice(2);
        const sig = v1Part.slice(3);
        const expected = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
        return safeCompare(expected, sig);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
