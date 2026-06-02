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
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as HttpServer, createServer } from 'http';
import knex, { type Knex } from 'knex';
import nodemailer from 'nodemailer';
import { Server as SocketIoServer } from 'socket.io';

// --- domain (use cases + ports) -----------------------------------------
import {
  ComputeAnalytics,
} from '../domain/analytics/usecases/computeAnalytics.js';
import {
  AttachScreenshot,
} from '../domain/annotation/usecases/attachScreenshot.js';
import {
  ChangeAnnotationStatus,
} from '../domain/annotation/usecases/changeAnnotationStatus.js';
import {
  CreateAnnotation,
} from '../domain/annotation/usecases/createAnnotation.js';
import {
  DeleteAnnotation,
} from '../domain/annotation/usecases/deleteAnnotation.js';
import {
  UpdateAnnotation,
} from '../domain/annotation/usecases/updateAnnotation.js';
import {
  CompletePasswordReset,
} from '../domain/auth/usecases/completePasswordReset.js';
import { Login } from '../domain/auth/usecases/login.js';
import { Logout } from '../domain/auth/usecases/logout.js';
import { RefreshToken } from '../domain/auth/usecases/refreshToken.js';
import { RegisterUser } from '../domain/auth/usecases/registerUser.js';
import {
  RequestPasswordReset,
} from '../domain/auth/usecases/requestPasswordReset.js';
import { VerifyEmail } from '../domain/auth/usecases/verifyEmail.js';
import { CreateComment } from '../domain/comment/usecases/createComment.js';
import { ListComments } from '../domain/comment/usecases/listComments.js';
import {
  CreateCustomGuideline,
} from '../domain/guideline/usecases/createCustomGuideline.js';
import {
  ListGuidelines,
} from '../domain/guideline/usecases/listGuidelines.js';
import {
  DispatchPendingNotifications,
} from '../domain/notification/usecases/dispatchPendingNotifications.js';
import {
  ArchiveProject,
} from '../domain/project/usecases/archiveProject.js';
import { CreateProject } from '../domain/project/usecases/createProject.js';
import { DeletePage } from '../domain/project/usecases/deletePage.js';
import {
  DeleteProject,
} from '../domain/project/usecases/deleteProject.js';
import {
  ExportProjectReport,
} from '../domain/project/usecases/exportProjectReport.js';
import { GetProject } from '../domain/project/usecases/getProject.js';
import {
  ListProjectMembers,
} from '../domain/project/usecases/listProjectMembers.js';
import {
  ResolveProjectByUrl,
} from '../domain/project/usecases/resolveProjectByUrl.js';
import {
  SearchProjects,
} from '../domain/project/usecases/searchProjects.js';
import {
  CreateSharedLink,
} from '../domain/sharedLink/usecases/createSharedLink.js';
import {
  VerifyLinkPassword,
} from '../domain/sharedLink/usecases/verifyLinkPassword.js';
import { CreateTeam } from '../domain/team/usecases/createTeam.js';
import { InviteMember } from '../domain/team/usecases/inviteMember.js';
import { ListTeams } from '../domain/team/usecases/listTeams.js';
import { RemoveMember } from '../domain/team/usecases/removeMember.js';
import {
  UpdateMemberRole,
} from '../domain/team/usecases/updateMemberRole.js';
import { GetCurrentUser } from '../domain/user/usecases/getCurrentUser.js';
import { UpdateProfile } from '../domain/user/usecases/updateProfile.js';
import {
  UpdateNotificationPreferences,
} from '../domain/user/usecases/updateNotificationPreferences.js';

// --- outbound adapters ---------------------------------------------------
import { PgAnalyticsRepo } from '../adapters/outbound/postgres/PgAnalyticsRepo.js';
import { PgAnnotationRepo } from '../adapters/outbound/postgres/PgAnnotationRepo.js';
import { PgAuthTokenRepo } from '../adapters/outbound/postgres/PgAuthTokenRepo.js';
import { PgMembershipRepo } from '../adapters/outbound/postgres/PgMembershipRepo.js';
import { PgCommentRepo } from '../adapters/outbound/postgres/PgCommentRepo.js';
import { PgGuidelineRepo } from '../adapters/outbound/postgres/PgGuidelineRepo.js';
import { PgNotificationQueue } from '../adapters/outbound/postgres/PgNotificationQueue.js';
import { PgPageRepo } from '../adapters/outbound/postgres/PgPageRepo.js';
import { PgProjectPinSequence } from '../adapters/outbound/postgres/PgProjectPinSequence.js';
import { PgProjectRepo } from '../adapters/outbound/postgres/PgProjectRepo.js';
import { PgSharedLinkRepo } from '../adapters/outbound/postgres/PgSharedLinkRepo.js';
import { PgTeamMemberRepo } from '../adapters/outbound/postgres/PgTeamMemberRepo.js';
import { PgTeamRepo } from '../adapters/outbound/postgres/PgTeamRepo.js';
import { PgUserRepo } from '../adapters/outbound/postgres/PgUserRepo.js';
import {
  S3ScreenshotStore,
  type S3ScreenshotStoreConfig,
} from '../adapters/outbound/s3/S3ScreenshotStore.js';
import { NodemailerMailer } from '../adapters/outbound/smtp/NodemailerMailer.js';
import { SocketIoEventBus } from '../adapters/outbound/socket/SocketIoEventBus.js';
import { BcryptPasswordHasher } from '../adapters/outbound/bcrypt/BcryptPasswordHasher.js';
import { JwtTokenIssuer } from '../adapters/outbound/jwt/JwtTokenIssuer.js';
import { SystemClock } from '../adapters/outbound/clock/SystemClock.js';
import { PinoLogger, pino, pinoHttp } from '../adapters/outbound/logger/PinoLogger.js';
import { PdfKitReportRenderer } from '../adapters/outbound/report/PdfKitReportRenderer.js';

// --- inbound adapters ----------------------------------------------------
import { mountInboundHttp, type InboundHttpDeps } from '../adapters/inbound/http/index.js';
import {
  installCollabGateway,
} from '../adapters/inbound/websocket/collab.gateway.js';
import {
  createNotificationWorker,
  type NotificationWorker,
} from '../adapters/inbound/workers/notificationWorker.js';

// --- request-pipeline middleware ----------------------------------------
// `authRateLimiter` enforces the per-IP+email cap on auth endpoints
// (Req 19.1). `csrfMiddleware` is the double-submit-cookie verifier the
// dashboard's `apiFetch` pairs with `setCsrfToken`. `legacyApiCatchAll`
// returns 410 Gone for any path under `/api/` that isn't `/api/v1/*`,
// preserving the URL deprecation policy from Req 25.2.
import { authRateLimiter } from '../middleware/authRateLimit.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { legacyApiCatchAll } from '../middleware/legacyApi.js';

// --- screenshot redaction helper (used as `applyRedactionBlur`) ---------
import { applyRedactionBlur as applyRedactionBlurImpl } from '../services/screenshotRedaction.js';

// =======================================================================
// Configuration
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
  bcryptSaltRounds: number;
  db: DbConfig;
  s3: S3Config;
  smtp: SmtpConfig;
  jwt: JwtConfig;
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

  return {
    nodeEnv,
    port: Number(env.PORT) || 3001,
    corsOrigin: env.CORS_ORIGIN || '*',
    appUrl: env.APP_URL || 'http://localhost:5173',
    cookieInsecure: isTest,
    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    notificationIntervalMs: Number(env.NOTIFICATION_INTERVAL_MS) || 5_000,
    notificationBatchSize: Number(env.NOTIFICATION_BATCH_SIZE) || 10,
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
  };
}

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
    pool: { min: config.db.poolMin, max: config.db.poolMax },
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

  // ---- Outbound adapters ----------------------------------------------
  const userRepo = new PgUserRepo(db);
  const projectRepo = new PgProjectRepo(db);
  const pageRepo = new PgPageRepo(db);
  const annotationRepo = new PgAnnotationRepo(db);
  const commentRepo = new PgCommentRepo(db);
  const teamRepo = new PgTeamRepo(db);
  const teamMemberRepo = new PgTeamMemberRepo(db);
  const guidelineRepo = new PgGuidelineRepo(db);
  const sharedLinkRepo = new PgSharedLinkRepo(db);
  const analyticsRepo = new PgAnalyticsRepo(db);
  const authTokenRepo = new PgAuthTokenRepo(db);
  const membershipRepo = new PgMembershipRepo(db);
  const notificationQueue = new PgNotificationQueue(db);
  const pinSequence = new PgProjectPinSequence(db);

  const screenshotStoreConfig: S3ScreenshotStoreConfig = {
    bucket: config.s3.bucket,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    keyPrefix: config.s3.keyPrefix,
  };
  if (config.s3.endpoint) screenshotStoreConfig.endpoint = config.s3.endpoint;
  if (config.s3.publicBaseUrl) {
    screenshotStoreConfig.publicBaseUrl = config.s3.publicBaseUrl;
  }
  const screenshotStore = new S3ScreenshotStore(s3Client, screenshotStoreConfig);

  const passwordHasher = new BcryptPasswordHasher(config.bcryptSaltRounds);
  const tokenIssuer = new JwtTokenIssuer({
    secret: config.jwt.secret,
    // `accessTtl` is widened to `string` in the config record; the JWT
    // adapter expects `SignOptions['expiresIn']`, which accepts the same
    // human-readable string forms (e.g., `'24h'`).
    accessTtl: config.jwt.accessTtl as `${number}${'h' | 'm' | 's' | 'd'}` | number,
    graceWindowSeconds: config.jwt.graceWindowSeconds,
  });
  const clock = new SystemClock();
  const mailer = new NodemailerMailer(transporter, {
    fromAddress: config.smtp.fromAddress,
  });

  const reportRenderer = new PdfKitReportRenderer(db, s3Client, {
    bucket: config.s3.bucket,
    buildScreenshotUrl: (key) => screenshotStore.buildScreenshotUrl(key),
  });

  // ---- HTTP / Socket.IO infrastructure (so we can build EventBus) -----
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIoServer(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });
  const eventBus = new SocketIoEventBus(io);

  // ---- Helper closures ------------------------------------------------
  const runInTransaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    db.transaction((trx) => fn(trx));

  const buildVerifyEmailLink = (rawToken: string): string =>
    `${trimSlash(config.appUrl)}/verify-email/${rawToken}`;

  const buildResetLink = (rawToken: string): string =>
    `${trimSlash(config.appUrl)}/reset-password/${rawToken}`;

  const resolvePageUrls = async (
    annotations: { pageId: string }[],
    projectId: string,
  ): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    if (annotations.length === 0) return map;
    const pages = await pageRepo.listByProject(projectId);
    for (const p of pages) map.set(p.id, p.url);
    return map;
  };

  // ---- Use cases ------------------------------------------------------
  const login = new Login({ userRepo, passwordHasher, tokenIssuer, membershipRepo });
  const registerUser = new RegisterUser({
    userRepo,
    authTokenRepo,
    passwordHasher,
    notificationQueue,
    clock,
    buildVerifyEmailLink,
  });
  const refreshToken = new RefreshToken({ tokenIssuer, clock });
  const verifyEmail = new VerifyEmail({ authTokenRepo, userRepo, clock });
  const requestPasswordReset = new RequestPasswordReset({
    userRepo,
    authTokenRepo,
    mailer,
    clock,
    buildResetLink,
  });
  const completePasswordReset = new CompletePasswordReset({
    userRepo,
    authTokenRepo,
    passwordHasher,
    clock,
  });
  const logout = new Logout({ authTokenRepo });

  const createProject = new CreateProject({
    projectRepo,
    pageRepo,
    runInTransaction,
  });
  const searchProjects = new SearchProjects({ projectRepo });
  const getProject = new GetProject({ projectRepo, teamMemberRepo });
  const archiveProject = new ArchiveProject({ projectRepo, teamMemberRepo });
  const deleteProject = new DeleteProject({
    projectRepo,
    teamMemberRepo,
    eventBus,
  });
  const deletePage = new DeletePage({
    projectRepo,
    pageRepo,
    annotationRepo,
    teamMemberRepo,
  });
  const listProjectMembers = new ListProjectMembers({
    projectRepo,
    teamMemberRepo,
  });
  const resolveProjectByUrl = new ResolveProjectByUrl({
    projectRepo,
    pageRepo,
    teamMemberRepo,
  });
  const exportProjectReport = new ExportProjectReport({
    projectRepo,
    teamMemberRepo,
    reportRenderer,
    eventBus,
  });

  const computeAnalytics = new ComputeAnalytics({
    projectRepo,
    teamMemberRepo,
    analyticsRepo,
  });

  const createAnnotation = new CreateAnnotation({
    annotationRepo,
    projectRepo,
    pageRepo,
    teamMemberRepo,
    pinSequence,
    runInTransaction,
    clock,
    eventBus,
  });
  const updateAnnotation = new UpdateAnnotation({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
  });
  const changeAnnotationStatus = new ChangeAnnotationStatus({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
  });
  const deleteAnnotation = new DeleteAnnotation({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
  });
  const attachScreenshot = new AttachScreenshot({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    screenshotStore,
  });

  const createComment = new CreateComment({
    commentRepo,
    annotationRepo,
    eventBus,
  });
  const listComments = new ListComments({ commentRepo, annotationRepo });

  const createTeam = new CreateTeam({ teamRepo, teamMemberRepo });
  const listTeams = new ListTeams({ teamRepo, teamMemberRepo });
  const inviteMember = new InviteMember({
    teamRepo,
    teamMemberRepo,
    userRepo,
    eventBus,
  });
  const updateMemberRole = new UpdateMemberRole({
    teamRepo,
    teamMemberRepo,
    eventBus,
  });
  const removeMember = new RemoveMember({ teamRepo, teamMemberRepo });

  const createSharedLink = new CreateSharedLink({
    projectRepo,
    sharedLinkRepo,
    passwordHasher,
  });
  const verifyLinkPassword = new VerifyLinkPassword({
    sharedLinkRepo,
    passwordHasher,
    clock,
  });

  const listGuidelines = new ListGuidelines({ guidelineRepo });
  const createCustomGuideline = new CreateCustomGuideline({ guidelineRepo });

  const getCurrentUser = new GetCurrentUser({ userRepo });
  const updateProfile = new UpdateProfile({ userRepo });
  const updateNotificationPreferences = new UpdateNotificationPreferences({
    userRepo,
  });

  const dispatchPendingNotifications = new DispatchPendingNotifications({
    notificationQueue,
    userRepo,
    mailer,
    clock,
    logger,
  });

  // ---- Express middleware --------------------------------------------
  const httpLogger = pinoHttp({ logger: pinoInstance });
  app.use(httpLogger);
  app.use(helmet({
    contentSecurityPolicy: false, // CSP managed per-route if needed
    crossOriginEmbedderPolicy: false, // Allow extension to embed
  }));
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

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

  // Strict per-IP+email limiter for auth-sensitive endpoints (Req 19.1).
  app.post('/api/v1/auth/login', authRateLimiter);
  app.post('/api/v1/auth/register', authRateLimiter);
  app.post('/api/v1/auth/reset-password', authRateLimiter);
  app.post('/api/v1/auth/resend-verification', authRateLimiter);
  app.post('/api/v1/shared/:linkId/verify', authRateLimiter);

  // ---- Mount inbound HTTP adapter ------------------------------------
  const inboundHttpDeps: InboundHttpDeps = {
    auth: { tokenIssuer },
    authRoutes: {
      login,
      registerUser,
      refreshToken,
      verifyEmail,
      requestPasswordReset,
      completePasswordReset,
      logout,
      cookieInsecure: config.cookieInsecure,
    },
    projectsRoutes: {
      createProject,
      searchProjects,
      getProject,
      archiveProject,
      deleteProject,
      deletePage,
      listProjectMembers,
      resolveProjectByUrl,
      exportProjectReport,
      computeAnalytics,
    },
    annotationsRoutes: {
      createAnnotation,
      updateAnnotation,
      changeAnnotationStatus,
      deleteAnnotation,
      attachScreenshot,
      annotationRepo,
      resolvePageUrls,
      buildScreenshotUrl: (key) => screenshotStore.buildScreenshotUrl(key),
      applyRedactionBlur: (buffer, rects) => applyRedactionBlurImpl(buffer, rects),
    },
    commentsRoutes: {
      createComment,
      listComments,
    },
    teamsRoutes: {
      createTeam,
      listTeams,
      inviteMember,
      updateMemberRole,
      removeMember,
    },
    sharedLinkRoutes: {
      createSharedLink,
      verifyLinkPassword,
    },
    guidelinesRoutes: {
      listGuidelines,
      createCustomGuideline,
    },
    usersRoutes: {
      getCurrentUser,
      updateProfile,
      updateNotificationPreferences,
    },
  };
  mountInboundHttp(app, inboundHttpDeps);

  // ---- Health endpoints ----------------------------------------------
  app.get('/api/v1/health', async (_req, res) => {
    const checks: Record<string, string> = {};
    try {
      await db.raw('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks, uptime: process.uptime() });
  });
  app.get('/health', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', message: 'Database unreachable' });
    }
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
  installCollabGateway(io, { tokenIssuer });

  // ---- Notification worker -------------------------------------------
  const worker = createNotificationWorker({
    dispatchPendingNotifications,
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
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await worker.stop();
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
    start,
    stop,
  };
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
