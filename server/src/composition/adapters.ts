// Outbound adapter factory extracted from composition/container.ts
// (Mission E2 — Component Decomposition).

import { S3Client } from '@aws-sdk/client-s3';
import type { Knex } from 'knex';
import type { Transporter } from 'nodemailer';

import type { Config } from './config.js';

// --- Postgres repos -------------------------------------------------------
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
import { PgOAuthAccountRepo } from '../adapters/outbound/postgres/PgOAuthAccountRepo.js';
import { PgWebhookRepo } from '../adapters/outbound/postgres/PgWebhookRepo.js';
import { PgUserNotificationRepo } from '../adapters/outbound/postgres/PgUserNotificationRepo.js';
import { PgOrgRepo } from '../adapters/outbound/postgres/PgOrgRepo.js';
import { PgInvitationRepo } from '../adapters/outbound/postgres/PgInvitationRepo.js';
import { PgApiKeyRepo } from '../adapters/outbound/postgres/PgApiKeyRepo.js';
import { PgIntegrationRepo } from '../adapters/outbound/postgres/PgIntegrationRepo.js';

// --- Other outbound adapters -----------------------------------------------
import {
  S3ScreenshotStore,
  type S3ScreenshotStoreConfig,
} from '../adapters/outbound/s3/S3ScreenshotStore.js';
import { NodemailerMailer } from '../adapters/outbound/smtp/NodemailerMailer.js';
import { BcryptPasswordHasher } from '../adapters/outbound/bcrypt/BcryptPasswordHasher.js';
import { GoogleOAuthProvider } from '../adapters/outbound/oauth/GoogleOAuthProvider.js';
import { GitHubOAuthProvider } from '../adapters/outbound/oauth/GitHubOAuthProvider.js';
import { JwtTokenIssuer } from '../adapters/outbound/jwt/JwtTokenIssuer.js';
import { SystemClock } from '../adapters/outbound/clock/SystemClock.js';
import { PdfKitReportRenderer } from '../adapters/outbound/report/PdfKitReportRenderer.js';

// =======================================================================
// Adapters return type
// =======================================================================

export interface Adapters {
  userRepo: PgUserRepo;
  projectRepo: PgProjectRepo;
  pageRepo: PgPageRepo;
  annotationRepo: PgAnnotationRepo;
  commentRepo: PgCommentRepo;
  teamRepo: PgTeamRepo;
  teamMemberRepo: PgTeamMemberRepo;
  guidelineRepo: PgGuidelineRepo;
  sharedLinkRepo: PgSharedLinkRepo;
  analyticsRepo: PgAnalyticsRepo;
  authTokenRepo: PgAuthTokenRepo;
  membershipRepo: PgMembershipRepo;
  notificationQueue: PgNotificationQueue;
  pinSequence: PgProjectPinSequence;
  webhookRepo: PgWebhookRepo;
  userNotificationRepo: PgUserNotificationRepo;
  orgRepo: PgOrgRepo;
  invitationRepo: PgInvitationRepo;
  apiKeyRepo: PgApiKeyRepo;
  oauthAccountRepo: PgOAuthAccountRepo;
  integrationRepo: PgIntegrationRepo;
  screenshotStore: S3ScreenshotStore;
  passwordHasher: BcryptPasswordHasher;
  tokenIssuer: JwtTokenIssuer;
  clock: SystemClock;
  mailer: NodemailerMailer;
  reportRenderer: PdfKitReportRenderer;
  oauthProviders: Record<string, import('../domain/auth/usecases/oauthLogin.js').OAuthProvider>;
}

// =======================================================================
// Factory
// =======================================================================

export function buildAdapters(
  config: Config,
  db: Knex,
  s3Client: S3Client,
  transporter: Transporter,
): Adapters {
  // ---- Postgres repositories ------------------------------------------
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
  const webhookRepo = new PgWebhookRepo(db);
  const userNotificationRepo = new PgUserNotificationRepo(db);
  const orgRepo = new PgOrgRepo(db);
  const invitationRepo = new PgInvitationRepo(db);
  const apiKeyRepo = new PgApiKeyRepo(db);
  const oauthAccountRepo = new PgOAuthAccountRepo(db);
  const integrationRepo = new PgIntegrationRepo(db);

  // ---- S3 Screenshot Store --------------------------------------------
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

  // ---- Other adapters -------------------------------------------------
  const passwordHasher = new BcryptPasswordHasher(config.bcryptSaltRounds);
  const tokenIssuer = new JwtTokenIssuer({
    secret: config.jwt.secret,
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

  // ---- OAuth providers ------------------------------------------------
  const oauthProviders: Record<string, import('../domain/auth/usecases/oauthLogin.js').OAuthProvider> = {};
  if (config.oauth.google) {
    oauthProviders.google = new GoogleOAuthProvider(config.oauth.google.clientId, config.oauth.google.clientSecret);
  }
  if (config.oauth.github) {
    oauthProviders.github = new GitHubOAuthProvider(config.oauth.github.clientId, config.oauth.github.clientSecret);
  }

  return {
    userRepo,
    projectRepo,
    pageRepo,
    annotationRepo,
    commentRepo,
    teamRepo,
    teamMemberRepo,
    guidelineRepo,
    sharedLinkRepo,
    analyticsRepo,
    authTokenRepo,
    membershipRepo,
    notificationQueue,
    pinSequence,
    webhookRepo,
    userNotificationRepo,
    orgRepo,
    invitationRepo,
    apiKeyRepo,
    oauthAccountRepo,
    integrationRepo,
    screenshotStore,
    passwordHasher,
    tokenIssuer,
    clock,
    mailer,
    reportRenderer,
    oauthProviders,
  };
}
