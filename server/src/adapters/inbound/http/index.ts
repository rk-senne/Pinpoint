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
}
