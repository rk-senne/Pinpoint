// Configuration types and loader extracted from composition/container.ts
// (Mission E2 — Component Decomposition).

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
  corsOrigin: string;
  appUrl: string;
  /** True when cookies should NOT carry the `Secure` flag (test transport). */
  cookieInsecure: boolean;
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
}

// =======================================================================
// Loader
// =======================================================================

/**
 * Read the runtime configuration from `process.env` with reasonable
 * defaults for development and tests. Production missing-secret
 * validation is delegated to `validateConfig` (see `server/src/config.ts`)
 * which the caller invokes explicitly before `start()`.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isTest = nodeEnv === 'test';

  return {
    nodeEnv,
    port: Number(env.PORT) || 3001,
    corsOrigin: env.CORS_ORIGIN || '*',
    appUrl: env.APP_URL || 'http://localhost:5173',
    cookieInsecure: isTest,
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
      secret: env.JWT_SECRET || 'dev-secret-change-in-production',
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
  };
}
