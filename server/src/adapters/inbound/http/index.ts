// Inbound HTTP adapter — barrel + mount helper (Phase 1.5 / task 4.9.1).
//
// Exposes the per-aggregate factories plus a single `mountInboundHttp`
// helper that the composition root uses to wire every router into an
// Express `app` at the legacy URL paths. Keeping the mounting in one
// place means the composition root (task 4.10.2) only has to construct
// the dependencies and call `mountInboundHttp(app, deps)`.

import type { Express, NextFunction, Request, Response } from 'express';

import { createAuthMiddleware, type AuthMiddlewareDeps } from './auth.middleware.js';
import { createAuthRoutes, type AuthRouteDeps } from './auth.routes.js';
import { createProjectsRoutes, type ProjectsRouteDeps } from './projects.routes.js';
import {
  createAnnotationRoutes,
  type AnnotationRouteDeps,
} from './annotations.routes.js';
import { createCommentsRoutes, type CommentsRouteDeps } from './comments.routes.js';
import { createTeamsRoutes, type TeamsRouteDeps } from './teams.routes.js';
import {
  createSharedLinkRoutes,
  type SharedLinkRouteDeps,
} from './sharedLinks.routes.js';
import {
  createGuidelinesRoutes,
  type GuidelinesRouteDeps,
} from './guidelines.routes.js';
import { createUsersRoutes, type UsersRouteDeps } from './users.routes.js';
import { createWebhookRoutes, type WebhookRouteDeps } from './webhooks.routes.js';
import { createNotificationsRoutes, type NotificationsRouteDeps } from './notifications.routes.js';
import { createOrgRoutes, type OrgRouteDeps } from './org.routes.js';
import { createApiKeyRoutes, type ApiKeyRouteDeps } from './apiKeys.routes.js';
import { createFeedbackRoutes, type FeedbackRouteDeps } from './feedback.routes.js';
import { createHeatmapRoutes, type HeatmapRouteDeps } from './heatmap.routes.js';
import { createPremiumRoutes, type PremiumRouteDeps } from './premium.routes.js';
import { createClientPortalRoutes, type ClientPortalRouteDeps } from './clientPortal.routes.js';
import { createWorkflowRoutes, type WorkflowRouteDeps } from './workflow.routes.js';
import { createReportingRoutes, type ReportingRouteDeps } from './reporting.routes.js';
import { createOAuthRoutes, type OAuthRouteDeps } from './oauth.routes.js';
import { createBillingRoutes, type BillingRouteDeps } from './billing.routes.js';
import { createIntegrationsRoutes, type IntegrationsRouteDeps } from './integrations.routes.js';
import { serveApiDocs } from './apiDocs.js';

export {
  createAuthMiddleware,
  type AuthMiddlewareDeps,
  createAuthRoutes,
  type AuthRouteDeps,
  createProjectsRoutes,
  type ProjectsRouteDeps,
  createAnnotationRoutes,
  type AnnotationRouteDeps,
  createCommentsRoutes,
  type CommentsRouteDeps,
  createTeamsRoutes,
  type TeamsRouteDeps,
  createSharedLinkRoutes,
  type SharedLinkRouteDeps,
  createGuidelinesRoutes,
  type GuidelinesRouteDeps,
  createUsersRoutes,
  type UsersRouteDeps,
  createWebhookRoutes,
  type WebhookRouteDeps,
  createNotificationsRoutes,
  type NotificationsRouteDeps,
  createOrgRoutes,
  type OrgRouteDeps,
  createApiKeyRoutes,
  type ApiKeyRouteDeps,
  createFeedbackRoutes,
  type FeedbackRouteDeps,
  createHeatmapRoutes,
  type HeatmapRouteDeps,
  createPremiumRoutes,
  type PremiumRouteDeps,
  createClientPortalRoutes,
  type ClientPortalRouteDeps,
  createWorkflowRoutes,
  type WorkflowRouteDeps,
  createReportingRoutes,
  type ReportingRouteDeps,
  createOAuthRoutes,
  type OAuthRouteDeps,
  createBillingRoutes,
  type BillingRouteDeps,
  createIntegrationsRoutes,
  type IntegrationsRouteDeps,
  serveApiDocs,
};

export { sendDomainError, sendZodFailure } from './errors.js';

/**
 * Aggregate dependency record consumed by `mountInboundHttp`. Composed
 * out of the per-aggregate `*Deps` shapes minus the `authMiddleware`
 * field (this helper builds and threads the middleware itself from the
 * supplied `tokenIssuer`).
 */
export interface InboundHttpDeps {
  /** Wired authentication middleware factory inputs. */
  auth: AuthMiddlewareDeps;
  authRoutes: Omit<AuthRouteDeps, never>;
  projectsRoutes: Omit<ProjectsRouteDeps, 'authMiddleware'>;
  annotationsRoutes: Omit<AnnotationRouteDeps, 'authMiddleware'>;
  commentsRoutes: Omit<CommentsRouteDeps, 'authMiddleware'>;
  teamsRoutes: Omit<TeamsRouteDeps, 'authMiddleware'>;
  sharedLinkRoutes: Omit<SharedLinkRouteDeps, 'authMiddleware'>;
  guidelinesRoutes: Omit<GuidelinesRouteDeps, 'authMiddleware'>;
  usersRoutes: Omit<UsersRouteDeps, 'authMiddleware'>;
  webhooksRoutes: Omit<WebhookRouteDeps, 'authMiddleware'>;
  notificationsRoutes: Omit<NotificationsRouteDeps, 'authMiddleware'>;
  orgRoutes: Omit<OrgRouteDeps, 'authMiddleware'>;
  apiKeysRoutes: Omit<ApiKeyRouteDeps, 'authMiddleware'>;
  feedbackRoutes: Omit<FeedbackRouteDeps, 'authMiddleware'>;
  heatmapRoutes: Omit<HeatmapRouteDeps, 'authMiddleware'>;
  premiumRoutes: Omit<PremiumRouteDeps, 'authMiddleware'>;
  clientPortalRoutes: Omit<ClientPortalRouteDeps, 'authMiddleware'>;
  workflowRoutes: Omit<WorkflowRouteDeps, 'authMiddleware'>;
  reportingRoutes: Omit<ReportingRouteDeps, 'authMiddleware'>;
  oauthRoutes?: OAuthRouteDeps;
  billingRoutes?: Omit<BillingRouteDeps, 'authMiddleware'>;
  integrationsRoutes?: Omit<IntegrationsRouteDeps, 'authMiddleware'>;
}

/**
 * Mount every inbound HTTP router onto `app` at the canonical
 * `/api/v1/...` paths. Identical URL surface to the legacy mounting in
 * `server/src/index.ts` so swap-over (task 4.10.2) is a one-liner that
 * removes the legacy `app.use(...)` calls and adds
 * `mountInboundHttp(app, deps)`.
 */
export function mountInboundHttp(app: Express, deps: InboundHttpDeps): void {
  const authMiddleware: (req: Request, res: Response, next: NextFunction) => void =
    createAuthMiddleware(deps.auth);

  const authRouter = createAuthRoutes(deps.authRoutes);
  const projectsRouter = createProjectsRoutes({
    ...deps.projectsRoutes,
    authMiddleware,
  });
  const { projectAnnotationsRouter, annotationRouter } = createAnnotationRoutes({
    ...deps.annotationsRoutes,
    authMiddleware,
  });
  const commentsRouter = createCommentsRoutes({
    ...deps.commentsRoutes,
    authMiddleware,
  });
  const teamsRouter = createTeamsRoutes({
    ...deps.teamsRoutes,
    authMiddleware,
  });
  const { shareRouter, verifyRouter } = createSharedLinkRoutes({
    ...deps.sharedLinkRoutes,
    authMiddleware,
  });
  const guidelinesRouter = createGuidelinesRoutes({
    ...deps.guidelinesRoutes,
    authMiddleware,
  });
  const usersRouter = createUsersRoutes({
    ...deps.usersRoutes,
    authMiddleware,
  });
  const webhooksRouter = createWebhookRoutes({
    ...deps.webhooksRoutes,
    authMiddleware,
  });
  const notificationsRouter = createNotificationsRoutes({
    ...deps.notificationsRoutes,
    authMiddleware,
  });
  const orgRouter = createOrgRoutes({
    ...deps.orgRoutes,
    authMiddleware,
  });
  const apiKeysRouter = createApiKeyRoutes({
    ...deps.apiKeysRoutes,
    authMiddleware,
  });
  const feedbackRouter = createFeedbackRoutes({
    ...deps.feedbackRoutes,
    authMiddleware,
  });
  const heatmapRouter = createHeatmapRoutes({
    ...deps.heatmapRoutes,
    authMiddleware,
  });
  const premiumRouter = createPremiumRoutes({
    ...deps.premiumRoutes,
    authMiddleware,
  });
  const clientPortalRouter = createClientPortalRoutes({
    ...deps.clientPortalRoutes,
    authMiddleware,
  });
  const workflowRouter = createWorkflowRoutes({
    ...deps.workflowRoutes,
    authMiddleware,
  });
  const reportingRouter = createReportingRoutes({
    ...deps.reportingRoutes,
    authMiddleware,
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/projects', projectsRouter);
  app.use('/api/v1/projects/:id/annotations', projectAnnotationsRouter);
  app.use('/api/v1/annotations', annotationRouter);
  app.use('/api/v1/annotations/:id/comments', commentsRouter);
  app.use('/api/v1/teams', teamsRouter);
  app.use('/api/v1/projects/:id/share', shareRouter);
  app.use('/api/v1/shared', verifyRouter);
  app.use('/api/v1/guidelines', guidelinesRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/org', orgRouter);
  app.use('/api/v1/api-keys', apiKeysRouter);
  app.use('/api/v1/feedback', feedbackRouter);
  app.use('/api/v1/projects', heatmapRouter);
  app.use('/api/v1', premiumRouter);
  app.use('/api/v1/portals', clientPortalRouter);
  app.use('/api/v1/workflows', workflowRouter);
  app.use('/api/v1/reports', reportingRouter);
  app.get('/api/v1/docs.json', serveApiDocs);

  // OAuth routes (optional — only mounted when provider credentials are configured)
  if (deps.oauthRoutes) {
    const oauthRouter = createOAuthRoutes(deps.oauthRoutes);
    app.use('/api/v1/auth/oauth', oauthRouter);
  }

  // Billing routes (optional — only mounted when STRIPE_SECRET_KEY is set)
  if (deps.billingRoutes) {
    const billingRouter = createBillingRoutes({ ...deps.billingRoutes, authMiddleware });
    app.use('/api/v1/billing', billingRouter);
  }

  // Integrations routes (optional)
  if (deps.integrationsRoutes) {
    const integrationsRouter = createIntegrationsRoutes({ ...deps.integrationsRoutes, authMiddleware });
    app.use('/api/v1/integrations', integrationsRouter);
  }
}
