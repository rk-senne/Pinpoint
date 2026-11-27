import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv, parseTrustProxy } from './config.js';

describe('parseTrustProxy (F-09)', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['FALSE', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
    ['10.0.0.0/8, 172.16.0.0/12', '10.0.0.0/8, 172.16.0.0/12'],
  ])('%j → %j', (raw, expected) => {
    expect(parseTrustProxy(raw)).toBe(expected);
  });
});

describe('loadConfigFromEnv — hardening fields', () => {
  it('defaults trust proxy to false and reads TRUST_PROXY=1', () => {
    expect(loadConfigFromEnv({}).trustProxy).toBe(false);
    expect(loadConfigFromEnv({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('marks production / self-host / non-loopback binds as exposed', () => {
    expect(loadConfigFromEnv({ NODE_ENV: 'development' }).exposed).toBe(false);
    expect(loadConfigFromEnv({ NODE_ENV: 'production' }).exposed).toBe(true);
    expect(loadConfigFromEnv({ NODE_ENV: 'development', HOST: '0.0.0.0' }).exposed).toBe(true);
    expect(loadConfigFromEnv({ NODE_ENV: 'development', PINPOINT_SELF_HOST: '1' }).exposed).toBe(true);
  });

  it('uses OAUTH_STATE_SECRET when set, else a derived (not the raw JWT) dev key', () => {
    expect(loadConfigFromEnv({ OAUTH_STATE_SECRET: 'abc' }).oauthStateSecret).toBe('abc');
    const derived = loadConfigFromEnv({ JWT_SECRET: 'jwt-secret-value' }).oauthStateSecret;
    expect(derived).not.toContain('jwt-secret-value');
    expect(derived).toHaveLength(64);
  });
});
