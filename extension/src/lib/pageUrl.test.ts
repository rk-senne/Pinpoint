import { describe, expect, it } from 'vitest';

import { sanitizePageUrl } from './pageUrl';

describe('sanitizePageUrl', () => {
  it('strips the fragment', () => {
    expect(sanitizePageUrl('https://a.test/p?x=1#access_token=abc')).toBe('https://a.test/p?x=1');
  });

  it.each([
    'token', 'code', 'key', 'password', 'secret', 'session', 'auth', 'sig',
    'signature', 'access_token', 'id_token', 'API_KEY', 'sessionId', 'X-Amz-Signature',
  ])('redacts the value of %s but keeps the key', (k) => {
    const out = sanitizePageUrl(`https://a.test/p?${k}=SUPERSECRET&page=2`);
    expect(out).not.toContain('SUPERSECRET');
    expect(out).toContain(`${k}=REDACTED`);
    expect(out).toContain('page=2');
  });

  it('keeps non-sensitive params untouched, in order', () => {
    expect(sanitizePageUrl('https://a.test/p?b=2&a=1&utm_source=x')).toBe(
      'https://a.test/p?b=2&a=1&utm_source=x',
    );
  });

  it('drops embedded credentials', () => {
    expect(sanitizePageUrl('https://user:pw@a.test/p')).toBe('https://a.test/p');
  });

  it('handles valueless and encoded keys', () => {
    expect(sanitizePageUrl('https://a.test/?token&x=1')).toContain('token=REDACTED');
    expect(sanitizePageUrl('https://a.test/?%74oken=zzz')).not.toContain('zzz');
  });

  it('falls back to stripping query+fragment on unparseable input', () => {
    expect(sanitizePageUrl('not a url?token=abc#frag')).toBe('not a url');
  });
});
