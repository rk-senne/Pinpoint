// GET /api/v1/screenshots/:token — serves a locally stored screenshot PNG to
// a short-lived HMAC-signed URL (see LocalFsScreenshotStore). No cookie or
// bearer is needed so `<img src>` works from the dashboard and from the
// extension's host pages; the signed, expiring token IS the credential and is
// only ever minted by `GET /annotations/:id/screenshot` after the usual org +
// project access checks. The route only serves `.png` objects, never the
// markup JSON.

import { Router, type Request, type Response } from 'express';
import { sendError, paramString } from './errors.js';

export interface ScreenshotTokenRouteDeps {
  /** Returns the object key for a valid, unexpired token; null otherwise. */
  verifyToken: (token: string) => string | null;
  fetchScreenshotBuffer: (objectKey: string) => Promise<Buffer | null>;
}

export function createScreenshotTokenRoutes(deps: ScreenshotTokenRouteDeps): Router {
  const router = Router();

  router.get('/:token', async (req: Request, res: Response) => {
    const key = deps.verifyToken(paramString(req.params.token));
    if (!key || !key.endsWith('.png')) {
      sendError(res, 403, 'FORBIDDEN', 'This screenshot link is invalid or has expired.');
      return;
    }
    const body = await deps.fetchScreenshotBuffer(key);
    if (!body) {
      sendError(res, 404, 'NOT_FOUND', 'Screenshot not found.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // helmet defaults to `same-origin`; the extension embeds this <img> in
    // arbitrary host pages.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Disposition', 'inline');
    res.end(body);
  });

  return router;
}
