import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../webhookSignatureVerifier.js';

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret-123';
  const payload = '{"event":"test"}';

  it('verifies slack signature', () => {
    const ts = '1234567890';
    const baseString = `v0:${ts}:${payload}`;
    const sig = 'v0=' + createHmac('sha256', secret).update(baseString).digest('hex');
    expect(verifyWebhookSignature('slack', payload, sig, secret, ts)).toBe(true);
  });

  it('rejects invalid slack signature', () => {
    expect(verifyWebhookSignature('slack', payload, 'v0=bad', secret, '123')).toBe(false);
  });

  it('verifies github signature', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyWebhookSignature('github', payload, sig, secret)).toBe(true);
  });

  it('rejects invalid github signature', () => {
    expect(verifyWebhookSignature('github', payload, 'sha256=invalid', secret)).toBe(false);
  });

  it('verifies linear signature', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyWebhookSignature('linear', payload, sig, secret)).toBe(true);
  });

  it('verifies jira signature', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyWebhookSignature('jira', payload, sig, secret)).toBe(true);
  });

  it('verifies stripe signature', () => {
    const ts = '1234567890';
    const expected = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    const sig = `t=${ts},v1=${expected}`;
    expect(verifyWebhookSignature('stripe', payload, sig, secret)).toBe(true);
  });

  it('returns false for unknown provider', () => {
    expect(verifyWebhookSignature('unknown', payload, 'sig', secret)).toBe(false);
  });
});
