// Composition root (Phase 1.5 / task 4.10.1).
//
// This is the ONLY file in the project allowed to import from both
// `domain/` and `adapters/`. Its job is to:
//
//   1. Read configuration from the environment (`loadConfigFromEnv`).
//   2. Construct concrete outbound adapters (Postgres repos, S3 store,
//      Nodemailer mailer, Socket.IO event bus, JWT issuer, bcrypt
//      hasher, system clock, Pino logger, PDFKit renderer).
//   3. Construct each domain `Use_Case` with the right dependency
//      record.
//   4. Build the inbound surface: an Express `app` with cookie-parser,
//      CORS, rate limiting, CSRF, request-id logging, and the legacy
//      `/health` endpoints. The hex inbound HTTP routers are mounted
//      via `mountInboundHttp(app, deps)`.
//   5. Build a `http.Server` + Socket.IO server and install the
//      `/collab` namespace via `installCollabGateway(io, deps)`.
//   6. Build the notification worker via `createNotificationWorker`.
//   7. Wrap the whole thing in a `Container` object whose `start()` /
//      `stop()` methods own process lifecycle (listen, worker tick,
//      graceful shutdown).
//
// The lint config (`server/.eslintrc.cjs`) forbids domain code from
// importing adapters, but this file lives under `composition/` and is
// covered by the layering exception. No other file should mirror its
// import surface.

import { S3Client } from '@aws-sdk/client-s3';
import { createRequire } from 'node:module';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as HttpServer, createServer } from 'http';
import knex, { type Knex } from 'knex';
import nodemailer from 'nodemailer';
import { Server as SocketIoServer } from 'socket.io';

// --- extracted composition modules (Mission E2) --------------------------
import { Config, loadConfigFromEnv } from './config.js';
import { buildAdapters } from './adapters.js';
import { buildUseCases } from './usecases.js';

// --- domain (billing — inline because feature-flagged) -------------------
import {
  CreateCheckoutSession,
  HandleStripeWebhook,
  GetBillingPortal,
  GetUsageSummary,
  CheckGracePeriods,
} from '../domain/billing/usecases/billing.js';
import { DispatchWebhook } from '../domain/webhook/usecases/webhooks.js';

// --- outbound adapters (only those still directly used here) -------------
import { SocketIoEventBus } from '../adapters/outbound/socket/SocketIoEventBus.js';
import { WebhookDispatchingEventBus } from '../adapters/outbound/socket/WebhookDispatchingEventBus.js';
import { StripeBillingProvider } from '../adapters/outbound/stripe/StripeBillingProvider.js';
import { PinoLogger, pino, pinoHttp } from '../adapters/outbound/logger/PinoLogger.js';

// --- inbound adapters ----------------------------------------------------
import { mountInboundHttp, type InboundHttpDeps } from '../adapters/inbound/http/index.js';
import {
  installCollabGateway,
} from '../adapters/inbound/websocket/collab.gateway.js';
import {
  createNotificationWorker,
  type NotificationWorker,
} from '../adapters/inbound/workers/notificationWorker.js';
import {
  createDigestWorker,
  type DigestWorker,
} from '../adapters/inbound/workers/digestWorker.js';
import {
  createIntegrationRefreshWorker,
  type IntegrationRefreshWorker,
} from '../adapters/inbound/workers/integrationRefreshWorker.js';

// --- request-pipeline middleware ----------------------------------------
import { authRateLimiter } from '../middleware/authRateLimit.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { legacyApiCatchAll } from '../middleware/legacyApi.js';
import { securityHeaders } from '../middleware/securityHeaders.js';
import { inputSanitizer } from '../middleware/inputSanitizer.js';
import { requestId } from '../middleware/requestId.js';
import { compress } from '../middleware/compress.js';
import { cacheMiddleware } from '../middleware/cache.js';
import { createPlanLimitsMiddleware } from '../middleware/planLimits.js';
import { tenantRateLimit, type RedisRateLimitClient } from '../middleware/tenantRateLimit.js';
import { createRedisClients, createRedisRateLimitStore } from '../infrastructure/redis.js';
import { createAdapter } from '@socket.io/redis-adapter';

// --- services -----------------------------------------------------------
import { generateDailyDigest } from '../services/dailyDigest.js';
import { applyRedactionBlur as applyRedactionBlurImpl } from '../services/screenshotRedaction.js';

// =======================================================================
// Re-export config types for backward compatibility
// =======================================================================
export type { Config, DbConfig, S3Config, SmtpConfig, JwtConfig } from './config.js';
export { loadConfigFromEnv } from './config.js';

// =======================================================================
// Container
// =======================================================================

export interface Container {
  readonly config: Config;
  readonly app: Express;
  readonly httpServer: HttpServer;
  readonly io: SocketIoServer;
  readonly db: Knex;
  readonly worker: NotificationWorker;
  readonly notificationTriggers: import('../domain/notification/usecases/notificationTriggers.js').NotificationTriggers;
  readonly runDailyDigest: (orgId: string) => Promise<import('../services/dailyDigest.js').DigestData>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildContainer(config: Config): Container {
  // ---- Infrastructure singletons --------------------------------------
  const pinoInstance = pino({ level: config.logLevel });
  const logger = new PinoLogger(pinoInstance);

  const db: Knex = knex({
    client: 'pg',
    connection: {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
    },
    pool: {
      min: config.db.poolMin,
      max: config.db.poolMax,
      afterCreate: (conn: unknown, done: (err: Error | null, conn: unknown) => void) => {
        (conn as { query: (sql: string, cb: (err: Error | null, conn: unknown) => void) => void })
          .query('SET statement_timeout = 30000', (err) => done(err, conn));
      },
    },
    acquireConnectionTimeout: 10000,
  });

  const s3ClientConfig: ConstructorParameters<typeof S3Client>[0] = {
    region: config.s3.region,
  };
  if (config.s3.endpoint) s3ClientConfig.endpoint = config.s3.endpoint;
  if (config.s3.forcePathStyle) s3ClientConfig.forcePathStyle = true;
  const s3Client = new S3Client(s3ClientConfig);

  const smtpAuth =
    config.smtp.user && config.smtp.password
      ? { user: config.smtp.user, pass: config.smtp.password }
      : undefined;
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    ...(smtpAuth ? { auth: smtpAuth } : {}),
  });

  // ---- Build outbound adapters (delegated to adapters.ts) -------------
  const adapters = buildAdapters(config, db, s3Client, transporter);

  // ---- HTTP / Socket.IO infrastructure (so we can build EventBus) -----
  const app = express();
  const httpServer = createServer(app);
  // When corsOrigin is '*', use `true` to reflect the request's Origin header back.
  // A literal '*' with credentials is invalid per the Fetch spec — browsers reject
  // credentialed requests to a wildcard origin. Using `true` mirrors the incoming
  // Origin, which is functionally equivalent but spec-compliant. Credentials are
  // always enabled because both the Dashboard (cookie auth) and Extension (bearer)
  // send credentialed requests.
  const corsOriginResolved: string | boolean = config.corsOrigin === '*' ? true : config.corsOrigin;
  const io = new SocketIoServer(httpServer, {
    cors: { origin: corsOriginResolved, credentials: true },
  });

  // Wire Redis adapter for multi-instance Socket.IO when REDIS_URL is configured (D1).
  const redisClients = createRedisClients(config.redisUrl, logger);
  if (redisClients) {
    io.adapter(createAdapter(redisClients.primary, redisClients.subscriber));
  }

  const socketEventBus = new SocketIoEventBus(io);

  // Wrap the Socket.IO bus with webhook dispatch + activity recording.
  const dispatchWebhook = new DispatchWebhook({ webhookRepo: adapters.webhookRepo });
  const eventBus = new WebhookDispatchingEventBus(socketEventBus, dispatchWebhook, logger, db);

  // ---- Build domain use cases (delegated to usecases.ts) --------------
  const useCases = buildUseCases({ adapters, config, eventBus, logger, db });

  // ---- Helper closures (still needed for inbound deps) ----------------
  const resolvePageUrls = async (
    annotations: { pageId: string }[],
    projectId: string,
  ): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    if (annotations.length === 0) return map;
    const pages = await adapters.pageRepo.listByProject(projectId);
    for (const p of pages) map.set(p.id, p.url);
    return map;
  };

  // ---- Billing (feature-flagged on STRIPE_SECRET_KEY) ----------------
  let billingRouteDeps: import('../adapters/inbound/http/billing.routes.js').BillingRouteDeps | undefined;
  if (config.stripe) {
    const esmRequire = createRequire(__filename);
    const Stripe = esmRequire('stripe');
    const stripeInstance = new Stripe(config.stripe.secretKey);
    const billingProvider = new StripeBillingProvider(stripeInstance, config.stripe.webhookSecret);
    const billingDeps = { db, billingProvider, proPriceId: config.stripe.proPriceId };
    const createCheckoutSessionUc = new CreateCheckoutSession(billingDeps);
    const handleStripeWebhookUc = new HandleStripeWebhook(billingDeps);
    const getBillingPortalUc = new GetBillingPortal(billingDeps);
    const getUsageSummaryUc = new GetUsageSummary({ db });
    billingRouteDeps = {
      authMiddleware: (_req, _res, next) => next(),
      createCheckoutSession: createCheckoutSessionUc,
      handleStripeWebhook: handleStripeWebhookUc,
      getBillingPortal: getBillingPortalUc,
      getUsageSummary: getUsageSummaryUc,
      db,
    };
  }

  // ---- Express middleware --------------------------------------------
  const httpLogger = pinoHttp({ logger: pinoInstance });
  app.use(httpLogger);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(
    cors({
      origin: corsOriginResolved,
      credentials: true,
    }),
  );
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }));
  app.use(cookieParser());
  app.use(compress(1024));
  app.use(requestId);
  app.use(securityHeaders);
  app.use(inputSanitizer);

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMIT',
        message: 'Too many requests, please try again later.',
      },
    },
  });
  app.use('/api/', generalLimiter);

  app.use('/api/v1', csrfMiddleware);

  const redisRateLimitClient: RedisRateLimitClient | undefined = redisClients
    ? createRedisRateLimitStore(redisClients.primary)
    : undefined;
  app.use('/api/v1', tenantRateLimit({}, redisRateLimitClient));

  // Response caching on hot read-only endpoints (Enhancement 3).
  app.use('/api/v1/projects/:id/analytics', cacheMiddleware(60_000));
  app.use('/api/v1/guidelines', cacheMiddleware(300_000));
  app.use('/api/v1/docs.json', cacheMiddleware(3_600_000));

  // Strict per-IP+email limiter for auth-sensitive endpoints (Req 19.1).
  app.post('/api/v1/auth/login', authRateLimiter);
  app.post('/api/v1/auth/register', authRateLimiter);
  app.post('/api/v1/auth/reset-password', authRateLimiter);
  app.post('/api/v1/auth/resend-verification', authRateLimiter);
  app.post('/api/v1/shared/:linkId/verify', authRateLimiter);

  // Plan-limit checks on annotation creation and project creation.
  app.post('/api/v1/projects/:id/annotations', createPlanLimitsMiddleware(db, 'annotations'));
  app.post('/api/v1/projects', createPlanLimitsMiddleware(db, 'projects'));

  // ---- Mount inbound HTTP adapter ------------------------------------
  const inboundHttpDeps: InboundHttpDeps = {
    auth: { tokenIssuer: adapters.tokenIssuer },
    authRoutes: {
      login: useCases.login,
      registerUser: useCases.registerUser,
      refreshToken: useCases.refreshToken,
      verifyEmail: useCases.verifyEmail,
      requestPasswordReset: useCases.requestPasswordReset,
      completePasswordReset: useCases.completePasswordReset,
      logout: useCases.logout,
      cookieInsecure: config.cookieInsecure,
    },
    projectsRoutes: {
      createProject: useCases.createProject,
      searchProjects: useCases.searchProjects,
      getProject: useCases.getProject,
      archiveProject: useCases.archiveProject,
      deleteProject: useCases.deleteProject,
      deletePage: useCases.deletePage,
      listProjectMembers: useCases.listProjectMembers,
      resolveProjectByUrl: useCases.resolveProjectByUrl,
      exportProjectReport: useCases.exportProjectReport,
      computeAnalytics: useCases.computeAnalytics,
      db,
    },
    annotationsRoutes: {
      createAnnotation: useCases.createAnnotation,
      updateAnnotation: useCases.updateAnnotation,
      changeAnnotationStatus: useCases.changeAnnotationStatus,
      deleteAnnotation: useCases.deleteAnnotation,
      attachScreenshot: useCases.attachScreenshot,
      annotationRepo: adapters.annotationRepo,
      resolvePageUrls,
      buildScreenshotUrl: (key) => adapters.screenshotStore.buildScreenshotUrl(key),
      fetchScreenshotBuffer: (key) => adapters.screenshotStore.fetchScreenshot(key),
      applyRedactionBlur: (buffer, rects) => applyRedactionBlurImpl(buffer, rects),
      db,
    },
    commentsRoutes: {
      createComment: useCases.createComment,
      listComments: useCases.listComments,
      db,
    },
    teamsRoutes: {
      createTeam: useCases.createTeam,
      listTeams: useCases.listTeams,
      inviteMember: useCases.inviteMember,
      updateMemberRole: useCases.updateMemberRole,
      removeMember: useCases.removeMember,
      db,
    },
    sharedLinkRoutes: {
      createSharedLink: useCases.createSharedLink,
      verifyLinkPassword: useCases.verifyLinkPassword,
    },
    guidelinesRoutes: {
      listGuidelines: useCases.listGuidelines,
      createCustomGuideline: useCases.createCustomGuideline,
    },
    usersRoutes: {
      getCurrentUser: useCases.getCurrentUser,
      updateProfile: useCases.updateProfile,
      updateNotificationPreferences: useCases.updateNotificationPreferences,
    },
    webhooksRoutes: {
      registerWebhook: useCases.registerWebhook,
      deleteWebhook: useCases.deleteWebhook,
      webhookRepo: adapters.webhookRepo,
      db,
    },
    notificationsRoutes: {
      listUserNotifications: useCases.listUserNotifications,
      markNotificationRead: useCases.markNotificationRead,
      userNotificationRepo: adapters.userNotificationRepo,
    },
    orgRoutes: {
      inviteToOrg: useCases.inviteToOrg,
      acceptInvitation: useCases.acceptInvitation,
      membershipRepo: adapters.membershipRepo,
      orgRepo: adapters.orgRepo,
      userRepo: adapters.userRepo,
      tokenIssuer: adapters.tokenIssuer,
      db,
    },
    apiKeysRoutes: {
      apiKeyRepo: adapters.apiKeyRepo,
      db,
    },
    feedbackRoutes: {
      annotationRepo: adapters.annotationRepo,
      db,
    },
    heatmapRoutes: {
      db,
    },
    premiumRoutes: {
      db,
    },
    clientPortalRoutes: {
      db,
    },
    workflowRoutes: {
      db,
    },
    reportingRoutes: {
      db,
    },
    oauthRoutes: Object.keys(adapters.oauthProviders).length > 0 ? {
      oauthLogin: useCases.oauthLogin,
      providers: adapters.oauthProviders,
      callbackBaseUrl: config.oauth.callbackBaseUrl,
      appUrl: config.appUrl,
      cookieInsecure: config.cookieInsecure,
    } : undefined,
    billingRoutes: billingRouteDeps ? {
      createCheckoutSession: billingRouteDeps.createCheckoutSession,
      handleStripeWebhook: billingRouteDeps.handleStripeWebhook,
      getBillingPortal: billingRouteDeps.getBillingPortal,
      getUsageSummary: billingRouteDeps.getUsageSummary,
      db,
    } : undefined,
    integrationsRoutes: {
      integrationRepo: adapters.integrationRepo,
      oauthStateSecret: config.jwt.secret,
    },
    guestFeedbackRoutes: {
      annotationRepo: adapters.annotationRepo,
      sharedLinkRepo: adapters.sharedLinkRepo,
      pageRepo: adapters.pageRepo,
    },
    activityRoutes: {
      db,
    },
    bulkRoutes: {
      db,
    },
    triageRoutes: {
      db,
    },
    auditLogRoutes: {
      db,
    },
  };
  mountInboundHttp(app, inboundHttpDeps);

  // ---- Health endpoints (Mission D2: Enhanced Health & Readiness) ------

  let isShuttingDown = false;
  process.on('SIGTERM', () => { isShuttingDown = true; });
  process.on('SIGINT', () => { isShuttingDown = true; });

  const esmRequireHealth = createRequire(__filename);
  const pkgJson = esmRequireHealth('../../package.json') as { version: string };

  async function performReadinessCheck(): Promise<{
    status: 'ok' | 'degraded' | 'unhealthy';
    checks: Record<string, string>;
    info: {
      version: string;
      nodeVersion: string;
      uptime: number;
      memoryUsage: { rss: number; heapUsed: number };
    };
    httpStatus: number;
  }> {
    const checks: Record<string, string> = {};

    try {
      await db.raw('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    checks.redis = config.redisUrl ? 'configured' : 'not_configured';
    if (redisClients) {
      try {
        await redisClients.primary.ping();
        checks.redis = 'ok';
      } catch {
        checks.redis = 'error';
      }
    }
    checks.s3 = 'configured';

    const requiredOk = checks.database === 'ok';
    let status: 'ok' | 'degraded' | 'unhealthy';
    if (!requiredOk) {
      status = 'unhealthy';
    } else {
      const optionalValues = [checks.redis, checks.s3];
      const optionalOk = optionalValues.every(
        (v) => v === 'ok' || v === 'configured' || v === 'not_configured',
      );
      status = optionalOk ? 'ok' : 'degraded';
    }

    const mem = process.memoryUsage();
    const info = {
      version: pkgJson.version,
      nodeVersion: process.version,
      uptime: Math.floor(process.uptime()),
      memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed },
    };

    const httpStatus = status === 'unhealthy' ? 503 : 200;
    return { status, checks, info, httpStatus };
  }

  app.get('/health/live', (_req, res) => {
    if (isShuttingDown) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    const result = await performReadinessCheck();
    res.status(result.httpStatus).json({
      status: result.status,
      checks: result.checks,
      info: result.info,
    });
  });

  app.get('/health', async (_req, res) => {
    const result = await performReadinessCheck();
    res.status(result.httpStatus).json({
      status: result.status,
      checks: result.checks,
      info: result.info,
    });
  });

  app.get('/api/v1/health', async (_req, res) => {
    const checks: Record<string, string> = {};
    try {
      await db.raw('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    checks.redis = config.redisUrl ? 'configured' : 'not_configured';
    if (redisClients) {
      try { await redisClients.primary.ping(); checks.redis = 'ok'; } catch { checks.redis = 'error'; }
    }

    const allOk = Object.values(checks).every((v) => v === 'ok' || v === 'configured' || v === 'not_configured');
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks, uptime: process.uptime() });
  });

  // ---- Legacy /api/* catch-all (Req 25.2) ----------------------------
  app.use('/api', legacyApiCatchAll);

  // ---- Global error handler ------------------------------------------
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
    const message = err.message || 'An unexpected error occurred.';
    req.log?.error({ err, code, message }, 'Unhandled error');
    const body: { error: { code: string; message: string; details?: { stack?: string } } } = {
      error: { code, message },
    };
    if (config.nodeEnv !== 'production' && err.stack) {
      body.error.details = { stack: err.stack };
    }
    res.status(500).json(body);
  });

  // ---- Inbound WebSocket gateway --------------------------------------
  installCollabGateway(io, { tokenIssuer: adapters.tokenIssuer });

  // ---- Notification worker -------------------------------------------
  const worker = createNotificationWorker({
    dispatchPendingNotifications: useCases.dispatchPendingNotifications,
    logger,
    intervalMs: config.notificationIntervalMs,
    batchSize: config.notificationBatchSize,
  });

  // ---- Digest worker (feature-flagged) --------------------------------
  let digestWorker: DigestWorker | null = null;
  if (config.digestEnabled) {
    digestWorker = createDigestWorker({
      db,
      notificationQueue: adapters.notificationQueue,
      generateDailyDigest,
      logger,
    });
  }

  // ---- Integration refresh worker (feature-flagged on integrations) ---
  const integrationRefreshWorker: IntegrationRefreshWorker = createIntegrationRefreshWorker({
    db,
    logger,
  });

  // ---- Lifecycle ------------------------------------------------------
  let started = false;
  let stopped = false;

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.removeListener('error', onError);
        logger.info({ port: config.port }, 'Pinpoint API server listening');
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.port);
    });
    worker.start();
    digestWorker?.start();
    integrationRefreshWorker.start();
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await worker.stop();
    if (digestWorker) await digestWorker.stop();
    await integrationRefreshWorker.stop();
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await db.destroy();
  };

  return {
    config,
    app,
    httpServer,
    io,
    db,
    worker,
    notificationTriggers: useCases.notificationTriggers,
    runDailyDigest: (orgId: string) => generateDailyDigest(db, orgId),
    start,
    stop,
  };
}
