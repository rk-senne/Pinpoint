/**
 * Production / self-host configuration preflight (Mission A9).
 *
 * The original guard only ran when `NODE_ENV === 'production'`. That left a
 * dangerous gap: an operator self-hosting Pinpoint on a VM or container with
 * `NODE_ENV` unset (or `development`) bound to a public interface would boot
 * with dev-grade secrets — weak JWT key, wildcard CORS, insecure cookies,
 * the default `postgres` DB password, no integration encryption key — and
 * happily serve traffic to the internet.
 *
 * `validateConfig` now runs the STRICT checks whenever ANY of the following
 * hold (the "exposed" condition):
 *   - `NODE_ENV === 'production'`, or
 *   - `PINPOINT_SELF_HOST === '1'` (explicit opt-in for self-hosters), or
 *   - the server binds to a non-loopback host (`HOST` is set to anything
 *     other than a loopback address / unset).
 *
 * Rule for HOST: unset or a loopback literal (`localhost`, `127.0.0.1`,
 * `::1`) is treated as local-only and does NOT trigger strict mode on its
 * own. `0.0.0.0` / `::` / any routable address means the server is listening
 * on a public interface, so strict mode engages. A production container that
 * legitimately binds `0.0.0.0` is already in strict mode via `NODE_ENV`, so
 * this rule only adds coverage for the misconfigured-dev-exposed case.
 *
 * On success in strict mode it prints a one-line-per-secret boot report
 * classifying each required secret as present / default / missing WITHOUT
 * ever printing the value.
 */

const FORBIDDEN_PRODUCTION_SECRETS: ReadonlySet<string> = new Set([
  '',
  'dev-secret',
  'dev-secret-change-in-production',
  'change-me',
]);

/** Minimum acceptable JWT secret length, in bytes (256 bits). */
export const MIN_JWT_SECRET_BYTES = 32;

/** The dev-default DB password that must never reach an exposed deployment. */
const DEFAULT_DB_PASSWORD = 'postgres';

/** Dev-derived INTEGRATION_ENCRYPTION_KEY (base64 of the fixed dev seed). */
const DEV_INTEGRATION_KEY = Buffer.from('pinpoint-dev-integration-key-0001')
  .subarray(0, 32)
  .toString('base64');

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

export type SecretState = 'present' | 'default' | 'missing';

export interface BootReportEntry {
  name: string;
  state: SecretState;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '',
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
]);

/** True when HOST indicates a non-loopback (publicly reachable) bind. */
export function bindsNonLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  return !LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * True when the deployment should be treated as exposed and subjected to the
 * strict preflight: production, explicit self-host opt-in, or a non-loopback
 * bind.
 */
export function isExposedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  if (env.PINPOINT_SELF_HOST === '1') return true;
  // A container must bind 0.0.0.0 for its published port to work, so a
  // non-loopback bind alone can't distinguish "local docker compose" from
  // "dev build exposed to a network". PINPOINT_LOCAL_DEV=1 asserts the host
  // only publishes the port on loopback (the shipped docker-compose.yml
  // binds 127.0.0.1). It can never weaken production or explicit self-host
  // mode — both are checked above.
  if (env.PINPOINT_LOCAL_DEV === '1') return false;
  if (bindsNonLoopback(env.HOST)) return true;
  return false;
}

/** Decode a JWT secret's byte length (secrets are treated as raw utf8). */
function jwtSecretBytes(secret: string): number {
  return Buffer.byteLength(secret, 'utf8');
}

function isHex64(v: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(v);
}

function base64Bytes(v: string): number {
  return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
}

/**
 * Classify each required secret as present / default / missing for the boot
 * report. Never returns or logs the secret value itself.
 */
export function buildBootReport(env: NodeJS.ProcessEnv): BootReportEntry[] {
  const entries: BootReportEntry[] = [];

  const jwt = env.JWT_SECRET;
  entries.push({
    name: 'JWT_SECRET',
    state:
      jwt === undefined
        ? 'missing'
        : FORBIDDEN_PRODUCTION_SECRETS.has(jwt)
          ? 'default'
          : 'present',
  });

  const cors = env.CORS_ORIGIN;
  entries.push({
    name: 'CORS_ORIGIN',
    state: cors === undefined ? 'missing' : cors === '*' ? 'default' : 'present',
  });

  const dbPw = env.DB_PASSWORD;
  entries.push({
    name: 'DB_PASSWORD',
    state:
      dbPw === undefined || dbPw === ''
        ? 'missing'
        : dbPw === DEFAULT_DB_PASSWORD
          ? 'default'
          : 'present',
  });

  const encKey = env.INTEGRATION_ENCRYPTION_KEY;
  entries.push({
    name: 'INTEGRATION_ENCRYPTION_KEY',
    state:
      encKey === undefined || encKey.trim() === ''
        ? 'missing'
        : encKey.trim() === DEV_INTEGRATION_KEY
          ? 'default'
          : 'present',
  });

  const oauthState = env.OAUTH_STATE_SECRET;
  entries.push({
    name: 'OAUTH_STATE_SECRET',
    state: oauthState === undefined || oauthState.trim() === '' ? 'missing' : 'present',
  });

  return entries;
}

/**
 * Validates that the runtime configuration is safe for the current
 * environment. In strict (exposed) mode it rejects:
 *   - unset / empty / placeholder / sub-32-byte JWT_SECRET
 *   - missing or wildcard CORS_ORIGIN
 *   - insecure cookies (COOKIE_INSECURE=true)
 *   - TRUST_PROXY=true (spoofable client IP)
 *   - the default `postgres` DB password
 *   - missing OAUTH_STATE_SECRET
 *   - missing / wrong-length INTEGRATION_ENCRYPTION_KEY
 *   - missing / short METRICS_TOKEN (PP-07)
 *
 * On success in strict mode it prints a boot report via `report` (defaults to
 * console.info). Non-exposed deployments skip all checks.
 */
export function validateConfig(
  env: NodeJS.ProcessEnv = process.env,
  report: (line: string) => void = (line) => console.info(line),
): void {
  if (!isExposedDeployment(env)) {
    return;
  }

  const secret = env.JWT_SECRET;
  if (secret === undefined || FORBIDDEN_PRODUCTION_SECRETS.has(secret)) {
    throw new InvalidConfigError(
      'JWT_SECRET must be set to a non-default value for an exposed deployment ' +
        '(NODE_ENV=production, PINPOINT_SELF_HOST=1, or a non-loopback HOST bind). ' +
        'Refusing to start with an unset, empty, or development placeholder secret.',
    );
  }
  if (jwtSecretBytes(secret) < MIN_JWT_SECRET_BYTES) {
    throw new InvalidConfigError(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes (256 bits) for an exposed deployment.`,
    );
  }

  const corsOrigin = env.CORS_ORIGIN;
  if (!corsOrigin || corsOrigin === '*') {
    throw new InvalidConfigError(
      'CORS_ORIGIN must be set to a specific origin (e.g. https://app.pinpoint.dev) for an exposed deployment. ' +
        'A wildcard or missing value allows any website to make credentialed requests to the API.',
    );
  }

  // Insecure cookies (Secure flag stripped) must never ship on an exposed
  // deployment — session cookies would be sent over plaintext HTTP.
  if (env.COOKIE_INSECURE === 'true') {
    throw new InvalidConfigError(
      'COOKIE_INSECURE=true is not permitted for an exposed deployment; session cookies must carry the Secure flag.',
    );
  }

  // `trust proxy = true` trusts every X-Forwarded-For hop, so any client could
  // spoof its IP and sidestep the per-IP rate limiters. Use a hop count (1 for
  // a single ALB) or an explicit subnet list instead.
  if ((env.TRUST_PROXY ?? '').trim().toLowerCase() === 'true') {
    throw new InvalidConfigError(
      'TRUST_PROXY=true is not permitted for an exposed deployment (spoofable client IPs); set a hop count such as 1.',
    );
  }

  // Default DB password leaks an org-wide write primitive if the DB port is
  // ever reachable.
  if ((env.DB_PASSWORD ?? '') === DEFAULT_DB_PASSWORD) {
    throw new InvalidConfigError(
      "DB_PASSWORD must not be the default 'postgres' value for an exposed deployment.",
    );
  }

  // OAuth state signing secret (HMAC-signed state cookie). Without it the
  // OAuth callback CSRF protection falls back to a weak/absent key.
  if (env.OAUTH_STATE_SECRET === undefined || env.OAUTH_STATE_SECRET.trim() === '') {
    throw new InvalidConfigError(
      'OAUTH_STATE_SECRET must be set for an exposed deployment; it signs the OAuth state cookie.',
    );
  }

  // INTEGRATION_ENCRYPTION_KEY (A4): 32-byte key encrypting integration OAuth
  // tokens + client secrets at rest.
  const encKey = env.INTEGRATION_ENCRYPTION_KEY;
  if (encKey === undefined || encKey.trim() === '') {
    throw new InvalidConfigError(
      'INTEGRATION_ENCRYPTION_KEY must be set to a 32-byte key (base64 or 64-char hex) for an exposed deployment. ' +
        'It encrypts integration OAuth tokens and client secrets at rest.',
    );
  }
  const trimmed = encKey.trim();
  if (!isHex64(trimmed) && base64Bytes(trimmed) !== 32) {
    throw new InvalidConfigError(
      'INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64-char hex).',
    );
  }

  // PP-07: without a token /metrics is gated on the peer address, which behind a
  // reverse proxy / ALB is always the proxy's private IP — i.e. world-readable.
  // An exposed deployment must therefore set a bearer token (>= 16 chars).
  if ((env.METRICS_TOKEN ?? '').trim().length < 16) {
    throw new InvalidConfigError(
      'METRICS_TOKEN must be set (at least 16 characters) for an exposed deployment; ' +
        'without it GET /metrics would be readable by anyone behind the reverse proxy. ' +
        'Generate one with `openssl rand -base64 24`.',
    );
  }

  // All checks passed — emit the boot report (no values, states only).
  report('Pinpoint config preflight (exposed deployment) — required secrets:');
  for (const entry of buildBootReport(env)) {
    report(`  ${entry.name}: ${entry.state}`);
  }
}
