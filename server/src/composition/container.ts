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

import { createSlackWiring } from '../services/integrations/slackWiring.js';
import { S3Client } from '@aws-sdk/client-s3';
import { createRequire } from 'node:module';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createMetrics } from '../infrastructure/metrics.js';
import { installTenantContext, runAsSystem, runWithStore, systemScope } from '../infrastructure/tenantContext.js';
import rateLimit from 'express-rate-limit';
import { Server as HttpServer, createServer } from 'http';
import knex, { type Knex } from 'knex';
import nodemailer from 'nodemailer';
import { Server as SocketIoServer } from 'socket.io';

// --- extracted composition modules (Mission E2) --------------------------
import { Config, loadConfigFromEnv } from './config.js';
import { buildAdapters } from './adapters.js';
import { createScreenshotTokenRoutes } from '../adapters/inbound/http/screenshots.routes.js';
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
import { DEFAULT_GUIDELINES } from '../domain/guideline/DEFAULT_GUIDELINES.js';

// --- outbound adapters (only those still directly used here) -------------
import { SocketIoEventBus, SESSION_REVOKED_EVENT } from '../adapters/outbound/socket/SocketIoEventBus.js';
import { WebhookDispatchingEventBus } from '../adapters/outbound/socket/WebhookDispatchingEventBus.js';
import { StripeBillingProvider } from '../adapters/outbound/stripe/StripeBillingProvider.js';
import { PgBillingRepo } from '../adapters/outbound/postgres/PgBillingRepo.js';
import { PinoLogger, pino, pinoHttp } from '../adapters/outbound/logger/PinoLogger.js';
import { buildPinoOptions } from '../logger.js';

// --- inbound adapters ----------------------------------------------------
import { mountInboundHttp, type InboundHttpDeps } from '../adapters/inbound/http/index.js';
import { createAuthMiddleware } from '../adapters/inbound/http/auth.middleware.js';
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
import {
  createWebhookDeliveryWorker,
  type WebhookDeliveryWorker,
} from '../adapters/inbound/workers/webhookDeliveryWorker.js';

// --- request-pipeline middleware ----------------------------------------
import { authRateLimiter, loginRateLimiter } from '../middleware/authRateLimit.js';
import { createErrorHandler, uuidPathGuard } from './httpGuards.js';
import { createCsrfMiddleware } from '../middleware/csrf.js';
import { createAuditTrail } from '../middleware/auditTrail.js';
import { createCsrfBinder } from '../middleware/sessionCookies.js';
import { legacyApiCatchAll } from '../middleware/legacyApi.js';
import { securityHeaders } from '../middleware/securityHeaders.js';
import { inputSanitizer } from '../middleware/inputSanitizer.js';
import { requestId } from '../middleware/requestId.js';
import { compress } from '../middleware/compress.js';
import { cacheMiddleware } from '../middleware/cache.js';
import { registerPgTypeParsers } from './pgTypes.js';
import { createPlanLimitsMiddleware } from '../middleware/planLimits.js';
import { tenantRateLimit, orgIdFromVerifiedToken, type RedisRateLimitClient } from '../middleware/tenantRateLimit.js';
import { createWidgetCors } from '../middleware/widgetCors.js';
import { createWidgetRoutes } from '../adapters/inbound/http/widget.routes.js';
import { createProxyRoutes } from '../adapters/inbound/http/proxy.routes.js';
import { createWidgetAssetRoutes } from '../adapters/inbound/http/widgetAsset.routes.js';
import { createDeliverRoutes } from '../adapters/inbound/http/deliver.routes.js';
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
  // Redacting config (F-04): the same instance feeds pino-http, so request
  // headers (authorization, cookie, x-csrf-token, x-project-key) and response
  // set-cookie never reach the log stream.
  const pinoInstance = pino(buildPinoOptions(config.logLevel));
  const logger = new PinoLogger(pinoInstance);

  registerPgTypeParsers();
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
  // PP-08: push the AsyncLocalStorage tenant context into every pooled
  // connection so PostgreSQL RLS policies see app.current_org_id / app.system.
  installTenantContext(db);

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
  // Behind the ALB every client shares the proxy's IP unless Express is told
  // how many hops to trust. TRUST_PROXY (default false) → `1` on ECS.
  app.set('trust proxy', config.trustProxy);
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
  // DispatchWebhook now only ENQUEUES durable delivery rows (Mission A5b); the
  // signed HTTP delivery + retry runs in the webhook delivery worker below, so
  // a crash mid-backoff can't drop a delivery.
  const dispatchWebhook = new DispatchWebhook({
    webhookRepo: adapters.webhookRepo,
  });
  const eventBus = new WebhookDispatchingEventBus(socketEventBus, dispatchWebhook, logger, db);
  // PP-02: any token_version bump (logout, reset, revoke-sessions, removal) cuts live sockets.
  const revokeUserSockets = (userId: string): void =>
    eventBus.emit({ type: SESSION_REVOKED_EVENT, room: `user:${userId}`, payload: {} });
  adapters.userRepo.onSessionRevoked = revokeUserSockets;

  // ---- Build domain use cases (delegated to usecases.ts) --------------
  // Slack: auto-notify on new annotations (durable queue) + the channel deliverer.
  const slackWiring = createSlackWiring({
    db,
    integrationRepo: adapters.integrationRepo,
    notificationQueue: adapters.notificationQueue,
    logger,
    appUrl: config.appUrl,
    egressOptions: { allowHttp: config.nodeEnv !== 'production' && !config.exposed },
  });
  slackWiring.attach(eventBus);
  const useCases = buildUseCases({
    adapters,
    config,
    eventBus,
    logger,
    db,
    channelDeliverers: slackWiring.channelDeliverers,
  });

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
    const billingRepo = new PgBillingRepo(db);
    const billingDeps = { billingRepo, billingProvider, proPriceId: config.stripe.proPriceId };
    const createCheckoutSessionUc = new CreateCheckoutSession(billingDeps);
    const handleStripeWebhookUc = new HandleStripeWebhook(billingDeps);
    const getBillingPortalUc = new GetBillingPortal(billingDeps);
    const getUsageSummaryUc = new GetUsageSummary({ billingRepo });
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
  // Prometheus request metrics; `/metrics` itself is mounted below.
  const metrics = createMetrics({ token: config.metricsToken, collectDefaults: config.nodeEnv !== 'test' });
  app.use(metrics.middleware);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  // Dedicated credential-free CORS for the public widget surface (A2).
  // Mounted AHEAD of the global credentialed CORS so the widget path is
  // governed only by per-key allowed_origins, never the dashboard policy.
  app.use('/api/v1/widget', createWidgetCors({ apiKeyRepo: adapters.apiKeyRepo }));
  const globalCors = cors({
    origin: corsOriginResolved,
    credentials: true,
  });
  app.use((req, res, next) => {
    // The widget surface is governed solely by the credential-free widget
    // CORS above; the global credentialed dashboard policy must not clobber
    // its per-key Access-Control-Allow-Origin header.
    if (req.path === '/api/v1/widget' || req.path.startsWith('/api/v1/widget/')) {
      next();
      return;
    }
    // The public widget bundle (`/widget/*.js`) is loaded via <script> from
    // arbitrary customer origins: wildcard, credential-free CORS only.
    if (req.path.startsWith('/widget/')) {
      next();
      return;
    }
    globalCors(req, res, next);
  });
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }));
  app.use(cookieParser());
  // PP-08: open the per-request tenant scope AFTER the body parser (stream
  // callbacks would otherwise drop the AsyncLocalStorage store). The org comes
  // from the signed session token (pure crypto, no DB); the auth layer and the
  // pre-tenant lookups refine it (setCurrentOrg / runAsSystem). Starts with no
  // `system` flag, so anything not explicitly granted fails closed.
  const resolveTokenOrg = orgIdFromVerifiedToken(adapters.tokenIssuer);
  app.use((req, _res, next) => {
    runWithStore({ orgId: resolveTokenOrg(req) ?? null, system: false }, next);
  });
  app.use(compress(1024));
  app.use(requestId);
  app.use(securityHeaders);
  app.use(inputSanitizer);

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    // Per-IP ceiling on /api/*. Default 100/15min; raise via
    // API_RATE_LIMIT_MAX for load/E2E environments that run many
    // requests from one IP. The per-tenant limiter and the strict auth
    // limiter still apply on top.
    max: config.apiRateLimitMax,
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

  // PP-15: CSRF tokens are HMAC-bound to the session (user id + session start).
  const csrfBinder = createCsrfBinder({ secret: config.jwt.secret, tokenIssuer: adapters.tokenIssuer });
  app.use('/api/v1', createCsrfMiddleware({ tokenIssuer: adapters.tokenIssuer, apiKeyRepo: adapters.apiKeyRepo, binder: csrfBinder }));
  // Malformed UUID path ids → 400 instead of a Postgres 22P02 → 500 (F-14).
  app.use('/api/v1', uuidPathGuard);
  // PP-22: security audit trail (auth events, exports, sharing, integrations, invitations, roles).
  app.use('/api/v1', createAuditTrail({ db, tokenIssuer: adapters.tokenIssuer }));

  const redisRateLimitClient: RedisRateLimitClient | undefined = redisClients
    ? createRedisRateLimitStore(redisClients.primary)
    : undefined;
  // Runs before the per-router auth middleware, so the tenant is taken from the
  // verified session token itself (F-22), not from `req.user`.
  app.use(
    '/api/v1',
    tenantRateLimit(
      {
        maxTokens: config.tenantRateLimitMax,
        refillRate: config.tenantRateLimitMax / (60 * 60 * 1000),
      },
      redisRateLimitClient,
      orgIdFromVerifiedToken(adapters.tokenIssuer),
    ),
  );

  // Response caching is limited to the public, tenant-independent OpenAPI
  // document. Tenant data (analytics, guidelines, ...) must NEVER be cached
  // here: this runs before authentication and keys by URL only, so a cached
  // body would be replayed to other orgs and anonymous callers.
  app.use('/api/v1/docs.json', cacheMiddleware(3_600_000));

  // Strict per-IP+email limiter for auth-sensitive endpoints (Req 19.1).
  app.post('/api/v1/auth/login', loginRateLimiter);
  app.post('/api/v1/auth/register', authRateLimiter);
  app.post('/api/v1/auth/reset-password', authRateLimiter);
  app.post('/api/v1/auth/resend-verification', authRateLimiter);
  app.post('/api/v1/shared/:linkId/verify', authRateLimiter);

  // Plan-limit checks on annotation creation and project creation.
  app.post('/api/v1/projects/:id/annotations', createPlanLimitsMiddleware(db, 'annotations'));
  app.post('/api/v1/projects', createPlanLimitsMiddleware(db, 'projects'));

  // ---- Mount inbound HTTP adapter ------------------------------------
  const inboundHttpDeps: InboundHttpDeps = {
    auth: { tokenIssuer: adapters.tokenIssuer, apiKeyRepo: adapters.apiKeyRepo },
    authRoutes: {
      login: useCases.login,
      registerUser: useCases.registerUser,
      refreshToken: useCases.refreshToken,
      verifyEmail: useCases.verifyEmail,
      requestPasswordReset: useCases.requestPasswordReset,
      resendVerification: useCases.resendVerification,
      completePasswordReset: useCases.completePasswordReset,
      logout: useCases.logout,
      cookieInsecure: config.cookieInsecure,
      csrfBinder,
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
      presignScreenshotUrl: (key) => adapters.screenshotStore.presignScreenshotUrl(key),
      fetchScreenshotBuffer: (key) => adapters.screenshotStore.fetchScreenshot(key),
      fetchMarkupDocument: (key) => adapters.screenshotStore.fetchMarkupDocument(key),
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
      sharedLinkRepo: adapters.sharedLinkRepo,
      annotationRepo: adapters.annotationRepo,
      pageRepo: adapters.pageRepo,
      accessSecret: config.jwt.secret,
      cookieInsecure: config.cookieInsecure,
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
      cookieInsecure: config.cookieInsecure,
      inviteToOrg: useCases.inviteToOrg,
      acceptInvitation: useCases.acceptInvitation,
      membershipRepo: adapters.membershipRepo,
      orgRepo: adapters.orgRepo,
      userRepo: adapters.userRepo,
      tokenIssuer: adapters.tokenIssuer,
      revokeUserSockets,
      db,
    },
    apiKeysRoutes: {
      apiKeyRepo: adapters.apiKeyRepo,
      db,
    },
    feedbackRoutes: {
      annotationRepo: adapters.annotationRepo,
      db,
      eventBus,
    },
    heatmapRoutes: {
      db,
    },
    premiumRoutes: {
      db,
      voterHashSecret: config.jwt.secret,
      ...(redisRateLimitClient ? { rateLimitRedis: redisRateLimitClient } : {}),
    },
    clientPortalRoutes: {
      db,
      mailer: adapters.mailer,
      appUrl: config.appUrl,
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
      stateSecret: config.oauthStateSecret,
      csrfBinder,
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
      // Dedicated HMAC key, not the JWT signing key (key separation).
      oauthStateSecret: config.oauthStateSecret,
      oauthProviders: config.integrationOAuth,
      callbackBaseUrl: config.appUrl,
      cookieInsecure: config.cookieInsecure,
    },
    guestFeedbackRoutes: {
      sharedLinkRepo: adapters.sharedLinkRepo,
      createGuestAnnotation: useCases.createGuestAnnotation,
      accessSecret: config.jwt.secret,
      ...(redisRateLimitClient ? { rateLimitRedis: redisRateLimitClient } : {}),
    },
    activityRoutes: {
      db,
    },
    bulkRoutes: {
      db,
      annotationRepo: adapters.annotationRepo,
      eventBus,
    },
    triageRoutes: {
      db,
    },
    auditLogRoutes: {
      db,
    },
  };
  mountInboundHttp(app, inboundHttpDeps);
  
    // Public proxy review-link surface (Mission C1). Mounted OUTSIDE
    // `/api/v1` (no auth) at `GET /review/:linkId`: server-side-fetches the
    // project's target page via the SSRF egress guard and returns it wrapped
    // with an injected <base>, strict CSP, and the guest-feedback overlay.
    app.use('/review', systemScope);
    app.use(
      '/review',
      createProxyRoutes({
        sharedLinkRepo: adapters.sharedLinkRepo,
        pageRepo: adapters.pageRepo,
        egressOptions: { allowHttp: config.nodeEnv !== 'production' && !config.exposed },
        // The dashboard (possibly a different origin in production) frames it.
        frameAncestors: config.corsOrigin === '*' ? [] : [config.corsOrigin],
      }),
    );

  // Public widget bundle asset (Mission B3). Serves the Vite-built embed SDK
  // at `GET /widget/pinpoint-widget.js` with a wildcard CORS header (public,
  // credential-free script) so the Onboarding snippet works from any host
  // page. Mounted OUTSIDE `/api/v1` so the credentialed dashboard CORS policy
  // never governs it. Resolves the bundle from WIDGET_DIST_DIR (default
  // <repo>/widget/dist); 404s cleanly when the bundle has not been built.
  app.use('/widget', createWidgetAssetRoutes());

  // Public widget feedback surface (A1/A3). Project-bound pk_widget_ keys;
  // fail-closed per-key Redis rate limit + daily quota. Mounted directly
  // (outside mountInboundHttp) because its CORS/auth model is bespoke.
  app.use('/api/v1/widget', systemScope);
  app.use(
    '/api/v1/widget',
    createWidgetRoutes({
      apiKeyRepo: adapters.apiKeyRepo,
      createGuestAnnotation: useCases.createGuestAnnotation,
      ...(redisRateLimitClient ? { rateLimitRedis: redisRateLimitClient } : {}),
    }),
  );

  // One-click annotation → task delivery (C4). Mounted directly (outside
  // mountInboundHttp) so it can own its own TaskProvider registry; the
  // adapters route every outbound call through the SSRF egress guard
  // (safeFetch) and operate on the SecretBox-decrypted integration tokens.
  app.use(
    '/api/v1/annotations',
    createDeliverRoutes({
      authMiddleware: createAuthMiddleware({ tokenIssuer: adapters.tokenIssuer }),
      integrationRepo: adapters.integrationRepo,
      db,
      appUrl: config.appUrl,
    }),
  );

  // Local-disk screenshot driver: serves HMAC-signed, expiring screenshot URLs
  // (GET /api/v1/screenshots/:token). Not mounted for the S3 driver.
  if (adapters.screenshotTokenVerifier) {
    app.use(
      '/api/v1/screenshots',
      createScreenshotTokenRoutes({
        verifyToken: adapters.screenshotTokenVerifier,
        fetchScreenshotBuffer: (key) => adapters.screenshotStore.fetchScreenshot(key),
      }),
    );
  }

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

  app.get('/metrics', (req, res) => {
    void metrics.handler(req, res);
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
  // Generic 5xx body always; stack only in non-exposed development (F-14).
  app.use(createErrorHandler({ nodeEnv: config.nodeEnv, exposed: config.exposed }));

  // ---- Inbound WebSocket gateway --------------------------------------
  installCollabGateway(io, { tokenIssuer: adapters.tokenIssuer, db,
    // Cookie-authenticated sockets only from the dashboard origin (CSWSH guard).
    trustedCookieOrigins: config.corsOrigin === '*' ? [] : config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
  });

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

  // ---- Webhook delivery worker (Mission A5b) --------------------------
  // Consumes the durable webhook_deliveries queue: claims pending rows with
  // FOR UPDATE SKIP LOCKED, signs + POSTs them (standard-webhooks), retries
  // with backoff, and marks sent/failed. Reclaims pending rows after restart.
  const webhookDeliveryWorker: WebhookDeliveryWorker = createWebhookDeliveryWorker({
    dispatchWebhookDeliveries: useCases.dispatchWebhookDeliveries,
    logger,
    intervalMs: config.notificationIntervalMs,
    batchSize: config.notificationBatchSize,
  });

  // ---- Lifecycle ------------------------------------------------------
  let started = false;
  let stopped = false;

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;

    // Seed Nielsen's 10 default guidelines once (GAP 1). Idempotent: skip
    // when defaults already exist so restarts never duplicate them.
    try {
      // Boot-time seeding has no request tenant: run it in the trusted system
      // context, or RLS rejects the insert on a fresh database (PP-08).
      await runAsSystem(async () => {
        if (!(await adapters.guidelineRepo.hasDefaults())) {
          await adapters.guidelineRepo.insertMany([...DEFAULT_GUIDELINES]);
          logger.info({ count: DEFAULT_GUIDELINES.length }, 'Seeded default guidelines');
        }
      });
    } catch (err) {
      logger.error({ err }, 'Failed to seed default guidelines');
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.removeListener('error', onError);
        logger.info({ port: config.port, host: config.host }, 'Pinpoint API server listening');
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.port, config.host);
    });
    // Background workers are trusted server code that scan across tenants;
    // timers inherit the async context, so every tick runs as system.
    runAsSystem(() => {
      worker.start();
      digestWorker?.start();
      integrationRefreshWorker.start();
      webhookDeliveryWorker.start();
    });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await worker.stop();
    if (digestWorker) await digestWorker.stop();
    await integrationRefreshWorker.stop();
    await webhookDeliveryWorker.stop();
    // Stop accepting new requests and drop idle keep-alive sockets so the
    // close can complete; in-flight requests get until the deadline below.
    httpServer.closeIdleConnections?.();
    // `io.close()` also closes the attached HTTP server, so a separate
    // `httpServer.close()` would throw ERR_SERVER_NOT_RUNNING (exit 1, DB
    // pool left open). Wait for the server's own 'close' instead.
    const serverClosed = new Promise<void>((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.once('close', () => resolve());
    });
    io.close();
    const deadline = new Promise<void>((resolve) => {
      setTimeout(() => {
        httpServer.closeAllConnections?.();
        resolve();
      }, 10_000).unref();
    });
    await Promise.race([serverClosed, deadline]);
    if (redisClients) {
      await Promise.allSettled([redisClients.primary.quit(), redisClients.subscriber.quit()]);
    }
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
