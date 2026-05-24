import { Request, Response, NextFunction } from 'express';

/**
 * Legacy `/api/*` catch-all middleware (Requirement 25.2).
 *
 * Mounted at `/api` AFTER all `/api/v1/*` routers. Any request that
 * reaches it whose path is NOT under `/v1` receives a 410 Gone with
 * a JSON envelope pointing the caller at the v1 equivalent:
 *
 *   {
 *     error: {
 *       code: "API_VERSION_REMOVED",
 *       message: "This endpoint moved to /api/v1.",
 *       newPath: "/api/v1<remainder>"
 *     }
 *   }
 *
 * Unknown paths under `/api/v1/*` are passed through with `next()` so
 * the framework can produce its default 404 — those are not removed
 * legacy endpoints, just typos against the current version.
 */
export function legacyApiCatchAll(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/v1' || req.path.startsWith('/v1/')) {
    next();
    return;
  }
  res.status(410).json({
    error: {
      code: 'API_VERSION_REMOVED',
      message: 'This endpoint moved to /api/v1.',
      newPath: '/api/v1' + req.path,
    },
  });
}
