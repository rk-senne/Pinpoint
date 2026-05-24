/**
 * Production secret guard.
 *
 * Per design key decision #4 (Auth: cookie+CSRF for Dashboard, bearer JWT for Extension)
 * and Requirements 21.1 / 21.2, the API server MUST refuse to boot in production when
 * `JWT_SECRET` is unset, empty, or set to a known development placeholder.
 */

const FORBIDDEN_PRODUCTION_SECRETS: ReadonlySet<string> = new Set([
  '',
  'dev-secret',
  'dev-secret-change-in-production',
  'change-me',
]);

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Validates that the runtime configuration is safe for the current environment.
 *
 * Throws an `InvalidConfigError` when `NODE_ENV === 'production'` and `JWT_SECRET`
 * is unset, empty, or one of the well-known development placeholders.
 *
 * Reads from `env` (defaults to `process.env`) so the function is trivially testable
 * without mutating global state.
 */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const secret = env.JWT_SECRET;

  if (secret === undefined || FORBIDDEN_PRODUCTION_SECRETS.has(secret)) {
    throw new InvalidConfigError(
      'JWT_SECRET must be set to a non-default value when NODE_ENV=production. ' +
        'Refusing to start with an unset, empty, or development placeholder secret.',
    );
  }
}
