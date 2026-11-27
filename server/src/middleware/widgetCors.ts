// Dedicated widget CORS (Mission A2).
//
// The global CORS layer (composition/container.ts) is locked to the
// dashboard origin WITH credentials — correct for the cookie/CSRF surface,
// but fatal for a `<script>` widget embedded on arbitrary customer origins.
//
// This middleware handles ONLY `/api/v1/widget/*` and is the inverse policy:
//
//   • credential-FREE — never emits `Access-Control-Allow-Credentials`, so a
//     leaked widget key can't be paired with ambient cookies.
//   • Origin is reflected ONLY when it is present in the key's
//     `allowed_origins`. An empty `allowed_origins` list means "any origin"
//     (the key is the only secret) but STILL never credentials.
//
// The key is resolved from the `X-Project-Key` header here (the route does
// the authoritative lookup again); CORS must run before the route so the
// browser's preflight succeeds. It is mounted AHEAD of the global CORS for
// the widget path so the global credentialed policy never applies there.

import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { ApiKeyRepo } from '../domain/org/ports/ApiKeyRepo.js';

export interface WidgetCorsDeps {
  apiKeyRepo: ApiKeyRepo;
}

const ALLOW_METHODS = 'POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, X-Project-Key';

export function createWidgetCors(
  deps: WidgetCorsDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const { apiKeyRepo } = deps;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const origin = req.headers.origin;

    // Vary so caches don't serve one origin's ACAO to another.
    res.setHeader('Vary', 'Origin');

    // No Origin header (same-origin / non-browser) — nothing to reflect.
    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    // Preflight. Browsers NEVER send custom header values (X-Project-Key) on
    // an OPTIONS preflight — only the header *names* in
    // Access-Control-Request-Headers — so the key's allow-list can't be
    // consulted here. Approve the preflight for any origin: it carries no
    // credentials and no data, and only permits the browser to SEND the
    // real POST. The per-key origin allow-list is enforced on that POST
    // below (ACAO withheld → the browser blocks the response) and the route
    // independently rejects requests whose Origin isn't allowed.
    if (req.method === 'OPTIONS') {
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration -- credential-free preflight; real request is gated by the per-key allow-list below
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    const projectKey = req.headers['x-project-key'] as string | undefined;
    let allowed = false;

    if (projectKey) {
      const keyHash = createHash('sha256').update(projectKey).digest('hex');
      const apiKey = await apiKeyRepo.findByHash(keyHash);
      if (apiKey && apiKey.keyType === 'widget') {
        // Empty allow-list ⇒ any origin (never credentials); otherwise match.
        allowed =
          apiKey.allowedOrigins.length === 0 ||
          apiKey.allowedOrigins.includes(origin);
      }
    }

    if (allowed) {
      // Reflect the specific origin — never a wildcard, never credentials.
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration -- only reached when `allowed` (per-key allowed_origins match or an explicitly open widget key); no Allow-Credentials
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // Let the route know so it can hard-reject a disallowed origin instead of
    // relying solely on the browser discarding the response.
    (req as Request & { widgetOriginAllowed?: boolean }).widgetOriginAllowed = allowed;

    next();
  };
}
