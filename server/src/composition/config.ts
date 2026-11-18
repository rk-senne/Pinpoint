// Configuration types and loader extracted from composition/container.ts
// (Mission E2 — Component Decomposition).

import { createHmac } from 'node:crypto';
import { isExposedDeployment } from '../config.js';

// =======================================================================
// Configuration Interfaces
// =======================================================================

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMin: number;
  poolMax: number;
}

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  publicBaseUrl?: string;
  keyPrefix: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  fromAddress: string;
}

export interface JwtConfig {
  secret: string;
  accessTtl: string;
  graceWindowSeconds: number;
}

export interface Config {
  nodeEnv: string;
  port: number;
  /**
   * Network interface to bind (Mission A9). Defaults to `0.0.0.0` in a
   * container (production) so the service is reachable, and `localhost`
   * otherwise so a plain `npm start` on a dev box is not exposed. The config
   * preflight uses a non-loopback HOST as one of the triggers for strict
   * secret validation.
   */
  host: string;
  corsOrigin: string;
  appUrl: string;
  /** True when cookies should NOT carry the `Secure` flag (test transport). */
  cookieInsecure: boolean;
  /** Bearer token required to scrape GET /metrics; unset = private-network callers only. */
  metricsToken: string | undefined;
  /** Per-IP request ceiling for /api/* per 15 minutes. */
  apiRateLimitMax: number;
  /**
   * Express `trust proxy` setting (TRUST_PROXY). Default `false`. Behind the
   * ALB set `1` (exactly one trusted hop) so `req.ip` is the real client and
   * the per-IP rate limiters key on it; leaving it `false` behind a proxy
   * collapses every client onto the proxy's IP. Never `true` on an exposed
   * deployment (any client could spoof X-Forwarded-For).
   */
  trustProxy: boolean | number | string;
  /**
   * True for production / self-host / non-loopback bind (see
   * `isExposedDeployment`). Gates dev-only behaviour: stack traces in error
   * bodies and plain-http egress.
   */
  exposed: boolean;
  /** Per-organisation request ceiling per hour (TENANT_RATE_LIMIT_MAX, default 1000). */
  tenantRateLimitMax: number;
  /** HMAC key for the OAuth state cookie (OAUTH_STATE_SECRET). */
  oauthStateSecret: string;
  logLevel: string;
  notificationIntervalMs: number;
  notificationBatchSize: number;
  digestEnabled: boolean;
  bcryptSaltRounds: number;
  db: DbConfig;
  s3: S3Config;
  smtp: SmtpConfig;
  jwt: JwtConfig;
  oauth: {
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
    callbackBaseUrl: string;
  };
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    proPriceId: string;
  };
  /** Optional Redis URL for multi-instance rate limiting + Socket.IO adapter. */
  redisUrl?: string;
  /**
   * 32-byte key (base64 or 64-char hex) used to encrypt integration OAuth
   * tokens + clientSecret at rest (Mission A4). Required in production; a
   * stable derived dev default is used otherwise.
   */
  integrationEncryptionKey: string;
}

// =======================================================================
// Loader
// =======================================================================

/**
 * Parse TRUST_PROXY into the value Express' `trust proxy` accepts:
 * unset/''/'false' → false, 'true' → true, digits → hop count, anything else
 * (e.g. 'loopback', a CIDR list) → passed through as a string.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Read the runtime configuration from `process.env` with reasonable
 * defaults for development and tests. Production missing-secret
 * validation is delegated to `validateConfig` (see `server/src/config.ts`)
 * which the caller invokes explicitly before `start()`.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isTest = nodeEnv === 'test';
  const jwtSecret = env.JWT_SECRET || 'dev-secret-change-in-production';

  return {
    nodeEnv,
    port: Number(env.PORT) || 3001,
    host: env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : 'localhost'),
    corsOrigin: env.CORS_ORIGIN || '*',
    appUrl: env.APP_URL || 'http://localhost:5173',
    // COOKIE_INSECURE=true drops the Secure flag so a plain-HTTP local stack
    // (docker compose on http://localhost:4173, E2E on 127.0.0.1) can keep a
    // session. validateConfig() rejects it on any exposed deployment.
    cookieInsecure: isTest || env.COOKIE_INSECURE === 'true',
    apiRateLimitMax: Math.max(1, Number(env.API_RATE_LIMIT_MAX) || 100),
    metricsToken: env.METRICS_TOKEN || undefined,
    tenantRateLimitMax: Math.max(1, Number(env.TENANT_RATE_LIMIT_MAX) || 1000),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    exposed: isExposedDeployment(env),
    // validateConfig() requires OAUTH_STATE_SECRET on exposed deployments; in
    // local dev derive a domain-separated key from the JWT secret instead.
    oauthStateSecret:
      env.OAUTH_STATE_SECRET?.trim() ||
      createHmac('sha256', jwtSecret).update('pinpoint:oauth-state:v1').digest('hex'),
    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    notificationIntervalMs: Number(env.NOTIFICATION_INTERVAL_MS) || 5_000,
    notificationBatchSize: Number(env.NOTIFICATION_BATCH_SIZE) || 10,
    digestEnabled: env.DIGEST_ENABLED === 'true',
    bcryptSaltRounds: Number(env.BCRYPT_SALT_ROUNDS) || 10,
    db: {
      host: env.DB_HOST || 'localhost',
      port: Number(env.DB_PORT) || 5432,
      database: env.DB_NAME || (isTest ? 'pinpoint_test' : 'pinpoint'),
      user: env.DB_USER || 'postgres',
      password: env.DB_PASSWORD || 'postgres',
      poolMin: Number(env.DB_POOL_MIN) || 2,
      poolMax: Number(env.DB_POOL_MAX) || 10,
    },
    s3: {
      bucket: env.S3_BUCKET || 'pinpoint',
      region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      ...(env.S3_PUBLIC_BASE_URL ? { publicBaseUrl: env.S3_PUBLIC_BASE_URL } : {}),
      keyPrefix: env.S3_KEY_PREFIX || 'annotations/screenshots',
    },
    smtp: {
      host: env.SMTP_HOST || 'localhost',
      port: Number(env.SMTP_PORT) || 1025,
      secure: env.SMTP_SECURE === 'true',
      ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
      ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
      fromAddress: env.SMTP_FROM || 'no-reply@pinpoint.local',
    },
    jwt: {
      secret: jwtSecret,
      accessTtl: env.JWT_ACCESS_TTL || '24h',
      graceWindowSeconds:
        Number(env.JWT_GRACE_WINDOW_SECONDS) || 7 * 24 * 60 * 60,
    },
    oauth: {
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : undefined,
      callbackBaseUrl: env.OAUTH_CALLBACK_BASE_URL || `http://localhost:${Number(env.PORT) || 3001}`,
    },
    stripe: env.STRIPE_SECRET_KEY
      ? {
          secretKey: env.STRIPE_SECRET_KEY,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
          proPriceId: env.STRIPE_PRO_PRICE_ID || '',
        }
      : undefined,
    redisUrl: env.REDIS_URL || undefined,
    // A4: integration secret encryption key. In production this must be set to
    // a real 32-byte key (validated in server/src/config.ts). For dev/test we
    // derive a stable 32-byte key from a fixed seed so local encryption works
    // without configuration while never shipping as a production default.
    integrationEncryptionKey:
      env.INTEGRATION_ENCRYPTION_KEY ||
      Buffer.from('pinpoint-dev-integration-key-0001').subarray(0, 32).toString('base64'),
  };
}
