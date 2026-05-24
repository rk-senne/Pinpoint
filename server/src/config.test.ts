import { describe, it, expect } from 'vitest';
import { validateConfig, InvalidConfigError } from './config.js';

/**
 * Unit tests for validateConfig.
 *
 * Covers the matrix of forbidden JWT_SECRET values × NODE_ENV from
 * Requirements 21.1 (production must reject unset/empty/dev placeholders)
 * and 21.2 (non-production must accept any non-empty secret, and
 * production must accept a strong secret).
 */

const FORBIDDEN_VALUES: ReadonlyArray<{ label: string; secret: string | undefined }> = [
  { label: 'undefined (unset)', secret: undefined },
  { label: 'empty string', secret: '' },
  { label: 'dev-secret', secret: 'dev-secret' },
  { label: 'dev-secret-change-in-production', secret: 'dev-secret-change-in-production' },
  { label: 'change-me', secret: 'change-me' },
];

const NON_PRODUCTION_ENVS: ReadonlyArray<string | undefined> = [
  'development',
  'test',
  undefined,
];

function buildEnv(nodeEnv: string | undefined, jwtSecret: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  if (jwtSecret !== undefined) env.JWT_SECRET = jwtSecret;
  return env;
}

describe('validateConfig', () => {
  describe('NODE_ENV=production', () => {
    it.each(FORBIDDEN_VALUES)(
      'throws InvalidConfigError when JWT_SECRET is $label',
      ({ secret }) => {
        const env = buildEnv('production', secret);
        expect(() => validateConfig(env)).toThrow(InvalidConfigError);
      },
    );

    it('passes when JWT_SECRET is a strong random secret', () => {
      const env = buildEnv('production', 'a-strong-random-secret');
      expect(() => validateConfig(env)).not.toThrow();
    });

    it('passes for any other non-empty, non-blocklisted secret', () => {
      const env = buildEnv('production', 's3cret-with-entropy-9f8a2b1c4d5e6f70');
      expect(() => validateConfig(env)).not.toThrow();
    });
  });

  describe('non-production NODE_ENV', () => {
    for (const nodeEnv of NON_PRODUCTION_ENVS) {
      const envLabel = nodeEnv === undefined ? 'unset' : `'${nodeEnv}'`;

      describe(`NODE_ENV=${envLabel}`, () => {
        it.each(FORBIDDEN_VALUES)(
          'passes when JWT_SECRET is $label (no production guard applies)',
          ({ secret }) => {
            const env = buildEnv(nodeEnv, secret);
            expect(() => validateConfig(env)).not.toThrow();
          },
        );

        it('passes with a strong secret', () => {
          const env = buildEnv(nodeEnv, 'a-strong-random-secret');
          expect(() => validateConfig(env)).not.toThrow();
        });
      });
    }
  });

  it('defaults to process.env when no env argument is provided', () => {
    // Smoke test: the call signature should accept zero args without throwing
    // a TypeError. The actual outcome depends on the host process env, so we
    // only assert that calling it does not crash on the signature itself.
    const fn = () => validateConfig();
    // Either it throws InvalidConfigError (if host env is somehow misconfigured
    // for production) or it returns undefined. Anything else is a regression.
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidConfigError);
    }
  });
});
