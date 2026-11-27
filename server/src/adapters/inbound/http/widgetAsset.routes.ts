// Public widget bundle asset route (Mission B3 — part b).
//
// Serves the built embed SDK at `GET /widget/pinpoint-widget.js` so a site
// owner can drop the exact snippet surfaced by the Onboarding wizard:
//
//   <script src="{apiUrl}/widget/pinpoint-widget.js"></script>
//   <script>Pinpoint.init({ projectKey: '…', apiUrl: '{apiUrl}' });</script>
//
// WHAT THIS DOES
// ==============
//   * Resolves the Vite-built bundle from `widget/dist/pinpoint-widget.js`
//     (the `fileName` configured in `widget/vite.config.ts`). The directory
//     is resolved robustly from `WIDGET_DIST_DIR` with a sensible default
//     relative to this compiled file, so it works from both `server/dist`
//     and a dev `tsx`/`ts-node` run.
//   * `Content-Type: application/javascript`.
//   * `Cache-Control: public, max-age=300` — the bundle is immutable within
//     a deploy but short enough to pick up a new build quickly.
//   * `Access-Control-Allow-Origin: *` — the script is a PUBLIC asset loaded
//     cross-origin by arbitrary host pages. It carries NO credentials and no
//     secrets (the project key is supplied by the embedder at init time), so
//     a wildcard is correct here. This route is mounted OUTSIDE `/api/v1`, so
//     it is never governed by the credentialed dashboard CORS policy.
//   * `X-Content-Type-Options: nosniff` — the response is exactly JS; never
//     let a browser sniff it into another type.
//   * Returns a clean 404 JSON envelope when the bundle has not been built
//     yet (so a missing `dist/` surfaces as an actionable error, not a crash).

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** The Vite `lib.fileName` output — keep in lockstep with widget/vite.config.ts. */
export const WIDGET_BUNDLE_FILENAME = 'pinpoint-widget.js';

export interface WidgetAssetRouteDeps {
  /**
   * Absolute path to the widget `dist` directory. Defaults to
   * `WIDGET_DIST_DIR` env (resolved against cwd if relative) or a path
   * computed relative to this module: `../../../../../widget/dist` from
   * `server/dist/adapters/inbound/http/`, i.e. `<repo>/widget/dist`.
   */
  widgetDistDir?: string;
  /** Injectable file reader (tests stub this). Defaults to fs/promises.readFile. */
  readFileImpl?: (path: string) => Promise<Buffer | string>;
}

/** Resolve the widget dist directory from an explicit dep, env, or default. */
export function resolveWidgetDistDir(explicit?: string): string {
  const fromEnv = process.env.WIDGET_DIST_DIR;
  const candidate = explicit ?? fromEnv;
  if (candidate) {
    return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  }
  // __dirname at runtime is <repo>/server/dist/adapters/inbound/http.
  // Climb to the repo root then into widget/dist.
  return resolve(__dirname, '..', '..', '..', '..', '..', 'widget', 'dist');
}

export function createWidgetAssetRoutes(deps: WidgetAssetRouteDeps = {}): Router {
  const router = Router();
  const distDir = resolveWidgetDistDir(deps.widgetDistDir);
  const readFileImpl = deps.readFileImpl ?? readFile;
  const bundlePath = join(distDir, WIDGET_BUNDLE_FILENAME);

  // Public, unauthenticated file read: throttle per IP (generous; the bundle
  // is cached by browsers/CDNs, so legitimate traffic is tiny).
  const assetLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false });
  router.get(`/${WIDGET_BUNDLE_FILENAME}`, assetLimiter, async (_req: Request, res: Response) => {
    let source: Buffer | string;
    try {
      source = await readFileImpl(bundlePath);
    } catch {
      // Bundle not built yet (or path misconfigured) — fail cleanly, don't crash.
      res.status(404).json({
        error: {
          code: 'WIDGET_BUNDLE_NOT_BUILT',
          message:
            'The widget bundle has not been built. Run `npm run build --workspace widget`.',
          details: {},
        },
      });
      return;
    }

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // Public script loaded cross-origin by arbitrary host pages; no credentials.
    res.setHeader('Access-Control-Allow-Origin', '*');
    // helmet defaults CORP to same-origin, which makes browsers refuse the
    // script on every customer origin (ERR_BLOCKED_BY_RESPONSE). This asset
    // is public by design.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(source);
  });

  return router;
}
