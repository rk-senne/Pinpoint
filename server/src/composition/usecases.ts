// Domain use-case factory extracted from composition/container.ts
// (Mission E2 — Component Decomposition).

import type { Knex } from 'knex';

import type { Config } from './config.js';
import type { Adapters } from './adapters.js';

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
  RegisterWebhook, DispatchWebhook, DeleteWebhook,
} from '../domain/webhook/usecases/webhooks.js';
import {
  CreateUserNotification, ListUserNotifications, MarkNotificationRead,
} from '../domain/notification/usecases/userNotifications.js';
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

import type { PinoLogger } from '../adapters/outbound/logger/PinoLogger.js';
import type { WebhookDispatchingEventBus } from '../adapters/outbound/socket/WebhookDispatchingEventBus.js';

// =======================================================================
// Use cases return type
// =======================================================================

export interface UseCases {
  login: Login;
  registerUser: RegisterUser;
  refreshToken: RefreshToken;
  verifyEmail: VerifyEmail;
  requestPasswordReset: RequestPasswordReset;
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
}

export function buildUseCases(deps: BuildUseCasesDeps): UseCases {
  const { adapters, config, eventBus, logger, db } = deps;
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

  // ---- OAuth ----------------------------------------------------------
  const createOrgAndMembership = async (userId: string, userName: string): Promise<string> => {
    const [org] = await db('organizations')
      .insert({ name: `${userName}'s Org`, slug: `user-${userId.slice(0, 8)}`, plan: 'free' })
      .returning('id');
    await db('memberships').insert({ org_id: org.id, user_id: userId, role: 'owner', accepted_at: db.fn.now() });
    return org.id as string;
  };

  const oauthLogin = new OAuthLogin({
    providers: oauthProviders,
    oauthAccountRepo,
    userRepo,
    tokenIssuer,
    membershipRepo,
    createOrgAndMembership,
  });

  // ---- Project use cases ----------------------------------------------
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
    notificationTriggers,
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
  });
  const updateMemberRole = new UpdateMemberRole({
    teamRepo,
    teamMemberRepo,
    eventBus,
  });
  const removeMember = new RemoveMember({ teamRepo, teamMemberRepo });

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
  });

  // ---- Guidelines -----------------------------------------------------
  const listGuidelines = new ListGuidelines({ guidelineRepo });
  const createCustomGuideline = new CreateCustomGuideline({ guidelineRepo });

  // ---- User -----------------------------------------------------------
  const getCurrentUser = new GetCurrentUser({ userRepo });
  const updateProfile = new UpdateProfile({ userRepo });
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
  });

  // ---- Webhooks -------------------------------------------------------
  const registerWebhook = new RegisterWebhook({ webhookRepo });
  const dispatchWebhook = new DispatchWebhook({ webhookRepo });
  const deleteWebhook = new DeleteWebhook({ webhookRepo });
  const listUserNotifications = new ListUserNotifications({ userNotificationRepo });
  const markNotificationRead = new MarkNotificationRead({ userNotificationRepo });

  // ---- Org use cases --------------------------------------------------
  const inviteToOrg = new InviteToOrg({ invitationRepo, membershipRepo, clock, eventBus });
  const acceptInvitation = new AcceptInvitation({ invitationRepo, membershipRepo, clock });

  return {
    login,
    registerUser,
    refreshToken,
    verifyEmail,
    requestPasswordReset,
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
    deleteWebhook,
    createUserNotification,
    listUserNotifications,
    markNotificationRead,
    notificationTriggers,
    inviteToOrg,
    acceptInvitation,
  };
}
