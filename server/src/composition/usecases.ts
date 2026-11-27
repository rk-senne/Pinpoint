import { randomBytes } from 'node:crypto';
// Domain use-case factory extracted from composition/container.ts
// (Mission E2 — Component Decomposition).

import type { Knex } from 'knex';

import type { Config } from './config.js';
import type { Adapters } from './adapters.js';
import type { DispatchPendingNotificationsDeps } from '../domain/notification/usecases/dispatchPendingNotifications.js';

// --- domain (use cases) ------------------------------------------------
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
  CreateGuestAnnotation,
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
import { OAuthLogin } from '../domain/auth/usecases/oauthLogin.js';
import { ResendVerification } from '../domain/auth/usecases/resendVerification.js';
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
  RegisterWebhook, DispatchWebhook, DispatchWebhookDeliveries, DeleteWebhook,
} from '../domain/webhook/usecases/webhooks.js';
import { assertPublicUrl, safeFetch } from '../services/egressGuard.js';
import {
  CreateUserNotification, ListUserNotifications, MarkNotificationRead,
} from '../domain/notification/usecases/userNotifications.js';
import { MfaService } from '../domain/auth/mfa/MfaService.js';
import {
  NotificationTriggers,
} from '../domain/notification/usecases/notificationTriggers.js';
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
import {
  InviteToOrg,
} from '../domain/org/usecases/inviteToOrg.js';
import {
  AcceptInvitation,
} from '../domain/org/usecases/acceptInvitation.js';

import { isOrgMember } from '../adapters/inbound/http/access.js';
import type { PinoLogger } from '../adapters/outbound/logger/PinoLogger.js';
import type { WebhookDispatchingEventBus } from '../adapters/outbound/socket/WebhookDispatchingEventBus.js';

// =======================================================================
// Use cases return type
// =======================================================================

export interface UseCases {
  login: Login;
  mfa: MfaService;
  registerUser: RegisterUser;
  refreshToken: RefreshToken;
  verifyEmail: VerifyEmail;
  requestPasswordReset: RequestPasswordReset;
  resendVerification: ResendVerification;
  completePasswordReset: CompletePasswordReset;
  logout: Logout;
  oauthLogin: OAuthLogin;
  createProject: CreateProject;
  searchProjects: SearchProjects;
  getProject: GetProject;
  archiveProject: ArchiveProject;
  deleteProject: DeleteProject;
  deletePage: DeletePage;
  listProjectMembers: ListProjectMembers;
  resolveProjectByUrl: ResolveProjectByUrl;
  exportProjectReport: ExportProjectReport;
  computeAnalytics: ComputeAnalytics;
  createAnnotation: CreateAnnotation;
  /** Guest/widget submissions (author_id NULL, is_guest). */
  createGuestAnnotation: CreateGuestAnnotation;
  updateAnnotation: UpdateAnnotation;
  changeAnnotationStatus: ChangeAnnotationStatus;
  deleteAnnotation: DeleteAnnotation;
  attachScreenshot: AttachScreenshot;
  createComment: CreateComment;
  listComments: ListComments;
  createTeam: CreateTeam;
  listTeams: ListTeams;
  inviteMember: InviteMember;
  updateMemberRole: UpdateMemberRole;
  removeMember: RemoveMember;
  createSharedLink: CreateSharedLink;
  verifyLinkPassword: VerifyLinkPassword;
  listGuidelines: ListGuidelines;
  createCustomGuideline: CreateCustomGuideline;
  getCurrentUser: GetCurrentUser;
  updateProfile: UpdateProfile;
  updateNotificationPreferences: UpdateNotificationPreferences;
  dispatchPendingNotifications: DispatchPendingNotifications;
  registerWebhook: RegisterWebhook;
  dispatchWebhook: DispatchWebhook;
  dispatchWebhookDeliveries: DispatchWebhookDeliveries;
  deleteWebhook: DeleteWebhook;
  createUserNotification: CreateUserNotification;
  listUserNotifications: ListUserNotifications;
  markNotificationRead: MarkNotificationRead;
  notificationTriggers: NotificationTriggers;
  inviteToOrg: InviteToOrg;
  acceptInvitation: AcceptInvitation;
}

// =======================================================================
// Factory
// =======================================================================

export interface BuildUseCasesDeps {
  adapters: Adapters;
  config: Config;
  eventBus: WebhookDispatchingEventBus;
  logger: PinoLogger;
  db: Knex;
  /** Extra notification channels (e.g. Slack) keyed by notification kind. */
  channelDeliverers?: DispatchPendingNotificationsDeps['channelDeliverers'];
}

export function buildUseCases(deps: BuildUseCasesDeps): UseCases {
  const { adapters, config, eventBus, logger, db, channelDeliverers } = deps;
  const {
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
    oauthAccountRepo,
    screenshotStore,
    passwordHasher,
    tokenIssuer,
    clock,
    mailer,
    reportRenderer,
    oauthProviders,
  } = adapters;

  // ---- Helper closures ------------------------------------------------
  const trimSlash = (s: string): string => s.replace(/\/+$/, '');

  const runInTransaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    db.transaction((trx) => fn(trx));

  const buildVerifyEmailLink = (rawToken: string): string =>
    `${trimSlash(config.appUrl)}/verify-email/${rawToken}`;

  const buildResetLink = (rawToken: string): string =>
    `${trimSlash(config.appUrl)}/reset-password/${rawToken}`;

  // ---- Auth use cases -------------------------------------------------
  /**
   * Idempotent, transactional personal-org provisioning shared by email
   * login and OAuth signup. A per-user advisory lock serializes concurrent
   * first logins so exactly one org is created; the slug carries random
   * bytes so it can't collide on the unique index.
   */
  const provisionPersonalOrg = (userId: string, userName: string): Promise<string> =>
    db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`personal-org:${userId}`]);
      const existing = await trx('memberships').where({ user_id: userId }).orderBy('created_at', 'asc').first();
      if (existing) return existing.org_id as string;
      const [org] = await trx('organizations')
        .insert({
          name: `${userName || 'My'}'s Org`.slice(0, 255),
          slug: `user-${userId.slice(0, 8)}-${randomBytes(4).toString('hex')}`,
          plan: 'free',
        })
        .returning('id');
      await trx('memberships').insert({ org_id: org.id, user_id: userId, role: 'owner', accepted_at: trx.fn.now() });
      return org.id as string;
    });
  const mfa = new MfaService({
    mfaRepo: adapters.mfaRepo,
    userRepo,
    passwordHasher,
    clock,
    challengeSecret: config.jwt.secret,
  });
  const login = new Login({ userRepo, passwordHasher, tokenIssuer, membershipRepo, provisionPersonalOrg, mfa });
  const registerUser = new RegisterUser({
    userRepo,
    authTokenRepo,
    passwordHasher,
    notificationQueue,
    clock,
    buildVerifyEmailLink,
  });
  const refreshToken = new RefreshToken({ tokenIssuer, clock, userRepo, membershipRepo });
  const verifyEmail = new VerifyEmail({ authTokenRepo, userRepo, clock });
  const requestPasswordReset = new RequestPasswordReset({
    userRepo,
    authTokenRepo,
    mailer,
    clock,
    logger,
    buildResetLink,
  });
  const resendVerification = new ResendVerification({
    userRepo,
    authTokenRepo,
    notificationQueue,
    clock,
    buildVerifyEmailLink,
  });
  const completePasswordReset = new CompletePasswordReset({
    userRepo,
    authTokenRepo,
    passwordHasher,
    clock,
  });
  const logout = new Logout({ authTokenRepo, userRepo });

  // ---- OAuth ----------------------------------------------------------
  const createOrgAndMembership = provisionPersonalOrg;

  const oauthLogin = new OAuthLogin({
    providers: oauthProviders,
    oauthAccountRepo,
    userRepo,
    tokenIssuer,
    membershipRepo,
    passwordHasher,
    authTokenRepo,
    createOrgAndMembership,
  });

  // ---- Project use cases ----------------------------------------------
  const createProject = new CreateProject({
    projectRepo,
    pageRepo,
    runInTransaction,
    teamRepo,
    teamMemberRepo,
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

  // ---- Analytics ------------------------------------------------------
  const computeAnalytics = new ComputeAnalytics({
    projectRepo,
    teamMemberRepo,
    analyticsRepo,
  });

  // ---- Notifications --------------------------------------------------
  const createUserNotification = new CreateUserNotification({ userNotificationRepo, eventBus });
  const notificationTriggers = new NotificationTriggers({ createUserNotification, userNotificationRepo });

  // ---- Annotation use cases -------------------------------------------
  const createAnnotationDeps = {
    annotationRepo,
    projectRepo,
    pageRepo,
    teamMemberRepo,
    pinSequence,
    runInTransaction,
    clock,
    eventBus,
  };
  const createAnnotation = new CreateAnnotation(createAnnotationDeps);
  const createGuestAnnotation = new CreateGuestAnnotation(createAnnotationDeps);
  const updateAnnotation = new UpdateAnnotation({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    eventBus,
    pageRepo,
  });
  const changeAnnotationStatus = new ChangeAnnotationStatus({
    annotationRepo,
    projectRepo,
    teamMemberRepo,
    notificationTriggers,
    eventBus,
    pageRepo,
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

  // ---- Comment use cases ----------------------------------------------
  const createComment = new CreateComment({
    commentRepo,
    annotationRepo,
    eventBus,
    notificationTriggers,
    isOrgMember: (orgId, userId) => isOrgMember(db, orgId, userId),
  });
  const listComments = new ListComments({ commentRepo, annotationRepo });

  // ---- Team use cases -------------------------------------------------
  const createTeam = new CreateTeam({ teamRepo, teamMemberRepo });
  const listTeams = new ListTeams({ teamRepo, teamMemberRepo });
  const inviteMember = new InviteMember({
    teamRepo,
    teamMemberRepo,
    userRepo,
    eventBus,
    membershipRepo,
  });
  const updateMemberRole = new UpdateMemberRole({
    teamRepo,
    teamMemberRepo,
    eventBus,
  });
  const removeMember = new RemoveMember({ teamRepo, teamMemberRepo, eventBus });

  // ---- Shared links ---------------------------------------------------
  const createSharedLink = new CreateSharedLink({
    projectRepo,
    sharedLinkRepo,
    passwordHasher,
  });
  const verifyLinkPassword = new VerifyLinkPassword({
    sharedLinkRepo,
    passwordHasher,
    clock,
    // Global per-link ceiling; the strict 3-strike lock is per (link, IP) in the route (PP-14).
    maxFailedAttempts: 30,
  });

  // ---- Guidelines -----------------------------------------------------
  const listGuidelines = new ListGuidelines({ guidelineRepo });
  const createCustomGuideline = new CreateCustomGuideline({ guidelineRepo });

  // ---- User -----------------------------------------------------------
  const getCurrentUser = new GetCurrentUser({ userRepo });
  const updateProfile = new UpdateProfile({
    userRepo,
    passwordHasher,
    authTokenRepo,
    mailer,
    clock,
    logger,
    buildConfirmLink: buildVerifyEmailLink,
  });
  const updateNotificationPreferences = new UpdateNotificationPreferences({
    userRepo,
  });

  // ---- Notification dispatch ------------------------------------------
  const dispatchPendingNotifications = new DispatchPendingNotifications({
    notificationQueue,
    userRepo,
    mailer,
    clock,
    logger,
    ...(channelDeliverers ? { channelDeliverers } : {}),
  });

  // ---- Webhooks -------------------------------------------------------
  // Wire the SSRF egress guard (Mission A5a). Allow plain http only outside
  // production so local dev endpoints keep working; prod is https-only.
  // Plain http egress is dev-only: never in production AND never on any
  // exposed deployment (self-host / non-loopback bind) (F-14).
  const egressOptions = { allowHttp: config.nodeEnv !== 'production' && !config.exposed };
  const registerWebhook = new RegisterWebhook({
    webhookRepo,
    assertPublicUrl: (url: string) => assertPublicUrl(url, egressOptions),
  });
  // DispatchWebhook only ENQUEUES durable delivery rows (Mission A5b). The
  // actual signed HTTP delivery + retry happens in the webhook delivery
  // worker via DispatchWebhookDeliveries, so a crash mid-backoff can't drop a
  // delivery.
  const dispatchWebhook = new DispatchWebhook({ webhookRepo });
  const dispatchWebhookDeliveries = new DispatchWebhookDeliveries({
    webhookRepo,
    safeFetch: (url, init) => safeFetch(url, init as never, egressOptions) as never,
  });
  const deleteWebhook = new DeleteWebhook({ webhookRepo });
  const listUserNotifications = new ListUserNotifications({ userNotificationRepo });
  const markNotificationRead = new MarkNotificationRead({ userNotificationRepo });

  // ---- Org use cases --------------------------------------------------
  const inviteToOrg = new InviteToOrg({ invitationRepo, membershipRepo, clock, eventBus, mailer, appUrl: config.appUrl });
  const acceptInvitation = new AcceptInvitation({ invitationRepo, membershipRepo, clock });

  return {
    login,
    mfa,
    registerUser,
    refreshToken,
    verifyEmail,
    requestPasswordReset,
    resendVerification,
    completePasswordReset,
    logout,
    oauthLogin,
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
    createAnnotation,
    createGuestAnnotation,
    updateAnnotation,
    changeAnnotationStatus,
    deleteAnnotation,
    attachScreenshot,
    createComment,
    listComments,
    createTeam,
    listTeams,
    inviteMember,
    updateMemberRole,
    removeMember,
    createSharedLink,
    verifyLinkPassword,
    listGuidelines,
    createCustomGuideline,
    getCurrentUser,
    updateProfile,
    updateNotificationPreferences,
    dispatchPendingNotifications,
    registerWebhook,
    dispatchWebhook,
    dispatchWebhookDeliveries,
    deleteWebhook,
    createUserNotification,
    listUserNotifications,
    markNotificationRead,
    notificationTriggers,
    inviteToOrg,
    acceptInvitation,
  };
}
