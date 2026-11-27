import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  InvalidConfigError,
  isExposedDeployment,
  bindsNonLoopback,
  buildBootReport,
  MIN_JWT_SECRET_BYTES,
} from './config.js';

/**
 * Unit tests for validateConfig (Mission A9 self-host preflight).
 *
 * The strict preflight runs whenever a deployment is "exposed":
 * NODE_ENV=production, PINPOINT_SELF_HOST=1, or a non-loopback HOST bind.
 * It preserves the original production guard behaviour (reject placeholder
 * JWT secrets, wildcard/missing CORS, missing encryption key) and adds
 * sub-32-byte JWT, default DB password, insecure cookies, and missing OAuth
 * state secret rejections.
 */

// A strong JWT secret that satisfies the >=32-byte rule.
const STRONG_JWT = 's3cret-with-entropy-9f8a2b1c4d5e6f70-xyz';
// A valid 32-byte key (base64) for the production "passes" paths.
const VALID_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const FORBIDDEN_VALUES: ReadonlyArray<{ label: string; secret: string | undefined }> = [
  { label: 'undefined (unset)', secret: undefined },
  { label: 'empty string', secret: '' },
  { label: 'dev-secret', secret: 'dev-secret' },
  { label: 'dev-secret-change-in-production', secret: 'dev-secret-change-in-production' },
  { label: 'change-me', secret: 'change-me' },
];

const NON_EXPOSED_ENVS: ReadonlyArray<string | undefined> = ['development', 'test', undefined];

interface EnvOpts {
  nodeEnv?: string;
  jwtSecret?: string;
  corsOrigin?: string;
  integrationKey?: string;
  dbPassword?: string;
  oauthStateSecret?: string;
  cookieInsecure?: string;
  selfHost?: string;
  host?: string;
}

/** Build a fully-valid exposed env, then apply overrides. */
function validExposedEnv(overrides: EnvOpts = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_JWT,
    CORS_ORIGIN: 'https://app.pinpoint.dev',
    INTEGRATION_ENCRYPTION_KEY: VALID_ENC_KEY,
    DB_PASSWORD: 'a-real-db-password',
    OAUTH_STATE_SECRET: 'a-real-oauth-state-secret',
    METRICS_TOKEN: 'a-real-metrics-token-0123456789',
  };
  return applyOverrides(env, overrides);
}

function applyOverrides(env: NodeJS.ProcessEnv, o: EnvOpts): NodeJS.ProcessEnv {
  if ('nodeEnv' in o) o.nodeEnv === undefined ? delete env.NODE_ENV : (env.NODE_ENV = o.nodeEnv);
  if ('jwtSecret' in o) o.jwtSecret === undefined ? delete env.JWT_SECRET : (env.JWT_SECRET = o.jwtSecret);
  if ('corsOrigin' in o) o.corsOrigin === undefined ? delete env.CORS_ORIGIN : (env.CORS_ORIGIN = o.corsOrigin);
  if ('integrationKey' in o) o.integrationKey === undefined ? delete env.INTEGRATION_ENCRYPTION_KEY : (env.INTEGRATION_ENCRYPTION_KEY = o.integrationKey);
  if ('dbPassword' in o) o.dbPassword === undefined ? delete env.DB_PASSWORD : (env.DB_PASSWORD = o.dbPassword);
  if ('oauthStateSecret' in o) o.oauthStateSecret === undefined ? delete env.OAUTH_STATE_SECRET : (env.OAUTH_STATE_SECRET = o.oauthStateSecret);
  if ('cookieInsecure' in o && o.cookieInsecure !== undefined) env.COOKIE_INSECURE = o.cookieInsecure;
  if ('selfHost' in o && o.selfHost !== undefined) env.PINPOINT_SELF_HOST = o.selfHost;
  if ('host' in o && o.host !== undefined) env.HOST = o.host;
  return env;
}

const noop = () => {};

describe('bindsNonLoopback', () => {
  it('treats unset / loopback hosts as local', () => {
    expect(bindsNonLoopback(undefined)).toBe(false);
    expect(bindsNonLoopback('')).toBe(false);
    expect(bindsNonLoopback('localhost')).toBe(false);
    expect(bindsNonLoopback('127.0.0.1')).toBe(false);
    expect(bindsNonLoopback('::1')).toBe(false);
  });

  it('treats routable / wildcard hosts as non-loopback', () => {
    expect(bindsNonLoopback('0.0.0.0')).toBe(true);
    expect(bindsNonLoopback('::')).toBe(true);
    expect(bindsNonLoopback('10.0.0.5')).toBe(true);
  });
});

describe('isExposedDeployment', () => {
  it('is true for production, self-host opt-in, or non-loopback bind', () => {
    expect(isExposedDeployment({ NODE_ENV: 'production' })).toBe(true);
    expect(isExposedDeployment({ PINPOINT_SELF_HOST: '1' })).toBe(true);
    expect(isExposedDeployment({ HOST: '0.0.0.0' })).toBe(true);
  });

  it('is false for a plain local dev process', () => {
    expect(isExposedDeployment({ NODE_ENV: 'development' })).toBe(false);
    expect(isExposedDeployment({})).toBe(false);
    expect(isExposedDeployment({ HOST: '127.0.0.1' })).toBe(false);
  });
});

describe('validateConfig — exposed (production)', () => {
  it.each(FORBIDDEN_VALUES)(
    'throws when JWT_SECRET is $label',
    ({ secret }) => {
      expect(() => validateConfig(validExposedEnv({ jwtSecret: secret }), noop)).toThrow(InvalidConfigError);
    },
  );

  it('throws when JWT_SECRET is shorter than the 32-byte minimum', () => {
    const short = 'a'.repeat(MIN_JWT_SECRET_BYTES - 1);
    expect(() => validateConfig(validExposedEnv({ jwtSecret: short }), noop)).toThrow(InvalidConfigError);
  });

  it('passes with a strong secret + specific CORS + valid enc key + real secrets', () => {
    expect(() => validateConfig(validExposedEnv(), noop)).not.toThrow();
  });

  it('throws when CORS_ORIGIN is unset', () => {
    expect(() => validateConfig(validExposedEnv({ corsOrigin: undefined }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when CORS_ORIGIN is a wildcard', () => {
    expect(() => validateConfig(validExposedEnv({ corsOrigin: '*' }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when COOKIE_INSECURE=true', () => {
    expect(() => validateConfig(validExposedEnv({ cookieInsecure: 'true' }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when TRUST_PROXY=true (spoofable client IP) but accepts a hop count', () => {
    expect(() => validateConfig({ ...validExposedEnv(), TRUST_PROXY: 'true' }, noop)).toThrow(InvalidConfigError);
    expect(() => validateConfig({ ...validExposedEnv(), TRUST_PROXY: '1' }, noop)).not.toThrow();
  });

  it("throws when DB_PASSWORD is the default 'postgres'", () => {
    expect(() => validateConfig(validExposedEnv({ dbPassword: 'postgres' }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when OAUTH_STATE_SECRET is missing', () => {
    expect(() => validateConfig(validExposedEnv({ oauthStateSecret: undefined }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when INTEGRATION_ENCRYPTION_KEY is unset', () => {
    expect(() => validateConfig(validExposedEnv({ integrationKey: undefined }), noop)).toThrow(InvalidConfigError);
  });

  it('throws when INTEGRATION_ENCRYPTION_KEY does not decode to 32 bytes', () => {
    expect(() => validateConfig(validExposedEnv({ integrationKey: 'too-short' }), noop)).toThrow(InvalidConfigError);
  });

  it('passes with a valid 64-char hex INTEGRATION_ENCRYPTION_KEY', () => {
    expect(() => validateConfig(validExposedEnv({ integrationKey: 'a'.repeat(64) }), noop)).not.toThrow();
  });

  it('prints a boot report with secret states but never values', () => {
    const lines: string[] = [];
    validateConfig(validExposedEnv(), (l) => lines.push(l));
    const joined = lines.join('\n');
    expect(joined).toContain('JWT_SECRET: present');
    expect(joined).toContain('OAUTH_STATE_SECRET: present');
    // Never leak the actual secret value.
    expect(joined).not.toContain(STRONG_JWT);
    expect(joined).not.toContain(VALID_ENC_KEY);
  });
});

describe('validateConfig — self-host + non-loopback triggers', () => {
  it('runs strict checks when PINPOINT_SELF_HOST=1 even if NODE_ENV is dev', () => {
    const env = applyOverrides(
      { NODE_ENV: 'development', PINPOINT_SELF_HOST: '1', JWT_SECRET: 'dev-secret' },
      {},
    );
    expect(() => validateConfig(env, noop)).toThrow(InvalidConfigError);
  });

  it('runs strict checks when bound to a non-loopback HOST', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', HOST: '0.0.0.0', JWT_SECRET: 'dev-secret' };
    expect(() => validateConfig(env, noop)).toThrow(InvalidConfigError);
  });
});

describe('validateConfig — non-exposed', () => {
  for (const nodeEnv of NON_EXPOSED_ENVS) {
    const label = nodeEnv === undefined ? 'unset' : `'${nodeEnv}'`;
    describe(`NODE_ENV=${label}`, () => {
      it.each(FORBIDDEN_VALUES)('passes regardless of JWT_SECRET ($label)', ({ secret }) => {
        const env: NodeJS.ProcessEnv = {};
        if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
        if (secret !== undefined) env.JWT_SECRET = secret;
        expect(() => validateConfig(env, noop)).not.toThrow();
      });
    });
  }
});

describe('buildBootReport', () => {
  it('classifies defaults, missing, and present without values', () => {
    const report = buildBootReport({
      JWT_SECRET: 'dev-secret',
      CORS_ORIGIN: '*',
      // DB_PASSWORD missing
      INTEGRATION_ENCRYPTION_KEY: VALID_ENC_KEY,
      // OAUTH_STATE_SECRET missing
    });
    const byName = Object.fromEntries(report.map((e) => [e.name, e.state]));
    expect(byName.JWT_SECRET).toBe('default');
    expect(byName.CORS_ORIGIN).toBe('default');
    expect(byName.DB_PASSWORD).toBe('missing');
    expect(byName.INTEGRATION_ENCRYPTION_KEY).toBe('present');
    expect(byName.OAUTH_STATE_SECRET).toBe('missing');
  });
});

describe('validateConfig default arg', () => {
  it('accepts a zero-arg call without a TypeError', () => {
    const fn = () => validateConfig(undefined, noop);
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidConfigError);
    }
  });
});

describe('isExposedDeployment — PINPOINT_LOCAL_DEV opt-out for local containers', () => {
  it('a 0.0.0.0 container bind is local when PINPOINT_LOCAL_DEV=1', () => {
    expect(isExposedDeployment({ NODE_ENV: 'development', HOST: '0.0.0.0', PINPOINT_LOCAL_DEV: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('without the opt-out a 0.0.0.0 bind is still treated as exposed', () => {
    expect(isExposedDeployment({ NODE_ENV: 'development', HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('can never weaken production or explicit self-host mode', () => {
    expect(isExposedDeployment({ NODE_ENV: 'production', PINPOINT_LOCAL_DEV: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isExposedDeployment({ PINPOINT_SELF_HOST: '1', PINPOINT_LOCAL_DEV: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('METRICS_TOKEN preflight (PP-07)', () => {
  it.each([undefined, '', '   ', 'short'])('rejects an exposed deployment with METRICS_TOKEN=%j', (token) => {
    const env = validExposedEnv();
    if (token === undefined) delete env.METRICS_TOKEN;
    else env.METRICS_TOKEN = token;
    expect(() => validateConfig(env, noop)).toThrow(/METRICS_TOKEN/);
  });

  it('accepts a long enough token and does not require one for local dev', () => {
    expect(() => validateConfig(validExposedEnv(), noop)).not.toThrow();
    expect(() => validateConfig({ NODE_ENV: 'development' }, noop)).not.toThrow();
  });
});

describe('validateConfig — screenshot storage', () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_JWT,
    CORS_ORIGIN: 'https://feedback.example.com',
    DB_PASSWORD: 'not-the-default',
    OAUTH_STATE_SECRET: 'state-secret',
    INTEGRATION_ENCRYPTION_KEY: VALID_ENC_KEY,
    METRICS_TOKEN: 'm'.repeat(20),
  };
  const run = (extra: NodeJS.ProcessEnv): void => validateConfig({ ...base, ...extra }, () => undefined);

  it('accepts local storage with an absolute directory and no S3 settings', () => {
    expect(() => run({ STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: '/data/screenshots' })).not.toThrow();
    expect(() => run({})).not.toThrow();
  });

  it('rejects an unknown driver and a relative local directory', () => {
    expect(() => run({ STORAGE_DRIVER: 'ftp' })).toThrow(InvalidConfigError);
    expect(() => run({ STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: './var/screenshots' })).toThrow(InvalidConfigError);
  });

  it('does not constrain the directory when S3 is the driver', () => {
    expect(() => run({ STORAGE_DRIVER: 's3', LOCAL_STORAGE_DIR: 'relative' })).not.toThrow();
  });
});
