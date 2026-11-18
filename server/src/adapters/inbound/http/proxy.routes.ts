// Proxy review-link route — the "no install" third reach mechanism
// (Mission C1). Public, mounted OUTSIDE `/api/v1` (no auth), at
// `GET /review/:linkId`.
//
// WHAT THIS DOES
// ==============
// Given a shared-link id, this route server-side-fetches the project's
// target page URL and returns its HTML wrapped with:
//   (a) an injected `<base href="https://origin/">` so the reviewer's
//       browser loads every relative asset (CSS/JS/images) DIRECTLY from
//       the real origin. We deliberately DO NOT proxy subresources — that
//       keeps this from becoming an open relay (an attacker can't point
//       `/review/:id` at arbitrary internal hosts and stream their bodies
//       back, because only the top-level document is fetched and only when
//       it is `text/html`).
//   (b) a `Content-Security-Policy` on the wrapper response whose `sandbox`
//       directive (no `allow-same-origin`) puts the third-party document in an
//       opaque origin, isolated from the Pinpoint origin's cookies/API.
//   (c) a small injected review overlay (`reviewOverlayScript`) that hands
//       feedback to the parent dashboard page via postMessage; the parent
//       POSTs it to the EXISTING guest endpoint
//       `POST /api/v1/shared/:linkId/feedback` (the frame is an opaque
//       origin and never calls the API itself).
//
// SECURITY MODEL
// ==============
//   * Every outbound fetch goes through `egressGuard.safeFetch`
//     (https-only, DNS-pinned to a validated public IP, metadata/private
//     ranges blocked). Redirects are followed manually (max 3) and EACH
//     hop is re-validated with `assertPublicUrl` before connecting — a
//     302 to `http://169.254.169.254/` is rejected.
//   * Response is capped at 5 MB and a 10s timeout; only `text/html` is
//     proxied, anything else is rejected.
//   * A missing link and a feedback-disabled link return a BYTE-FOR-BYTE
//     IDENTICAL 404 (same enumeration-oracle kill as guestFeedback).
//   * `X-Robots-Tag: noindex` + `<meta name="robots" content="noindex">`
//     so a proxied page is never indexed.
//
// HONEST LIMITATIONS (documented for the reviewer / README)
// =========================================================
//   * Sites that send `X-Frame-Options: DENY|SAMEORIGIN` or a CSP
//     `frame-ancestors` directive will refuse to render inside the
//     dashboard's sandboxed iframe — that is the remote site's choice and
//     this proxy cannot (and must not) strip those on the real origin.
//   * Sites that render entirely via client-side JS against an
//     authenticated session (SPA behind login) will show their logged-out
//     shell only, because we fetch the raw document anonymously.
//   * Subresources are loaded by the REVIEWER's browser from the origin
//     via the injected `<base>`, so pages requiring cookies/auth for their
//     assets may render incompletely.
//   * Password-protected links are not directly proxied: the content fetch
//     would leak the page before the password gate, so a link that carries
//     a `passwordHash` returns 401 `PASSWORD_REQUIRED` here. The password
//     prompt lives in the dashboard (`/shared/:linkId`); open links with
//     `allowFeedback` are the review-link happy path.

import { Router, type Request, type Response } from 'express';
import type { SharedLinkRepo } from '../../../domain/sharedLink/ports/SharedLinkRepo.js';
import type { PageRepo } from '../../../domain/project/ports/PageRepo.js';
import {
  assertPublicUrl,
  safeFetch,
  EgressBlockedError,
  type EgressGuardOptions,
  readBodyCapped,
} from '../../../services/egressGuard.js';
import { reviewOverlayScript } from './reviewOverlay.js';
import { paramString } from './errors.js';

/** 5 MB response cap for proxied HTML. */
export const PROXY_MAX_BYTES = 5 * 1024 * 1024;
/** At most 3 redirects, each re-validated. */
export const PROXY_MAX_REDIRECTS = 3;

/**
 * Minimal structural view of the fetch Response the route consumes. Kept
 * narrow so tests can hand in a plain object without constructing a real
 * undici Response.
 */
export interface ProxyFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  /** Streamed body; read with a byte cap so oversize pages are never fully buffered. */
  body?: ReadableStream<Uint8Array> | null;
}

/** Injectable fetch used by the proxy. Defaults to egress-guarded safeFetch. */
export type ProxySafeFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; redirect?: 'manual' },
  options?: EgressGuardOptions,
) => Promise<ProxyFetchResponse>;

export interface ProxyRouteDeps {
  sharedLinkRepo: SharedLinkRepo;
  pageRepo: PageRepo;
  /**
   * Overridable egress-guarded fetch (tests stub this). Defaults to the
   * real `safeFetch`. Must reject private/metadata targets and enforce
   * https.
   */
  safeFetchImpl?: ProxySafeFetch;
  /** Overridable URL validator (tests stub this). Defaults to assertPublicUrl. */
  assertPublicUrlImpl?: (url: string, options?: EgressGuardOptions) => Promise<unknown>;
  /** Passed through to the egress guard (allowHttp for local dev). */
  egressOptions?: EgressGuardOptions;
  /**
   * Exact origins allowed to iframe the proxy (the dashboard). `'self'` is
   * always allowed for same-origin deployments (Compose / dev proxy). Every
   * other origin is refused, so third parties can't reframe the proxy.
   */
  frameAncestors?: readonly string[];
}

/**
 * CSP `sandbox` applied to every proxy response. Deliberately omits
 * `allow-same-origin` (opaque origin), `allow-top-navigation*` and
 * `allow-modals`.
 */
export const PROXY_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';

/** Safe CSP source list from configured origins (scheme://host[:port] only). */
function frameAncestorSources(origins: readonly string[] = []): string {
  const valid = origins.filter((o) => {
    try {
      const u = new URL(o);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o.replace(/\/$/, '');
    } catch {
      return false;
    }
  });
  return ["'self'", ...valid].join(' ');
}

/**
 * The single canonical "this review link is unavailable" response. Used for
 * BOTH a missing link and a feedback-disabled link so the two are
 * indistinguishable from the outside (kills the enumeration oracle, mirrors
 * guestFeedback.sendLinkUnavailable).
 */
function sendUnavailable(res: Response): Response {
  return res
    .status(404)
    .type('text/html')
    .send('<!doctype html><title>Not found</title><p>Shared link not found.</p>');
}

/** Escape a URL for safe placement inside an HTML attribute context. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Inject `<base href>`, a `noindex` meta, and the review overlay script into
 * the fetched document. We insert immediately after an opening `<head>` when
 * present (so `<base>` governs relative-URL resolution for assets declared
 * later), else prepend a synthetic head.
 */
export function injectIntoHtml(html: string, origin: string, linkId: string): string {
  const baseTag = `<base href="${escapeAttr(origin)}">`;
  const robots = '<meta name="robots" content="noindex">';
  const overlay = `<script>${reviewOverlayScript(linkId)}</script>`;
  const headExtras = `${baseTag}${robots}`;

  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    const withHead = html.slice(0, at) + headExtras + html.slice(at);
    // Overlay goes right before </body> when present, else appended.
    const bodyClose = /<\/body>/i.exec(withHead);
    if (bodyClose) {
      return (
        withHead.slice(0, bodyClose.index) +
        overlay +
        withHead.slice(bodyClose.index)
      );
    }
    return withHead + overlay;
  }

  // No <head> — prepend a synthetic one and append the overlay.
  return `<head>${headExtras}</head>${html}${overlay}`;
}

/**
 * Follow redirects manually so each hop is re-validated by the egress guard
 * (a 30x `Location` pointing at a private/metadata host must be rejected).
 * Returns the final non-redirect response plus its resolved URL.
 */
async function fetchFollowingRedirects(
  startUrl: string,
  safeFetchImpl: ProxySafeFetch,
  assertPublicUrlImpl: (url: string, options?: EgressGuardOptions) => Promise<unknown>,
  egressOptions: EgressGuardOptions | undefined,
): Promise<{ response: ProxyFetchResponse; finalUrl: string }> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop++) {
    // Re-validate EVERY hop (including the first) before connecting.
    await assertPublicUrlImpl(currentUrl, egressOptions);
    const response = await safeFetchImpl(
      currentUrl,
      { method: 'GET', headers: { Accept: 'text/html', 'User-Agent': 'PinpointReviewProxy/1.0' }, redirect: 'manual' },
      egressOptions,
    );

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return { response, finalUrl: currentUrl };
    }
    const location = response.headers.get('location');
    if (!location) {
      return { response, finalUrl: currentUrl };
    }
    // Resolve relative Location against the current URL, then loop to
    // re-validate the resolved absolute URL on the next iteration.
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new EgressBlockedError('Too many redirects');
}

export function createProxyRoutes(deps: ProxyRouteDeps): Router {
  const router = Router();
  const ancestors = frameAncestorSources(deps.frameAncestors);
  router.use((_req, res, next) => {
    // The global security middleware sends X-Frame-Options: DENY. These
    // responses exist to be framed by the dashboard, so replace it with an
    // explicit frame-ancestors allow-list (CSP supersedes XFO in browsers).
    res.removeHeader('X-Frame-Options');
    // `sandbox` (no allow-same-origin) forces EVERY response from this router
    // into an opaque origin even on direct navigation, so reviewed-page
    // script can never act as the Pinpoint origin (cookies, CSRF, API).
    res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}; ${PROXY_SANDBOX}`);
    next();
  });
  const {
    sharedLinkRepo,
    pageRepo,
    safeFetchImpl = safeFetch as unknown as ProxySafeFetch,
    assertPublicUrlImpl = assertPublicUrl,
    egressOptions,
  } = deps;

  // `/review/:linkId/frame` is the canonical path the dashboard iframes:
  // the dashboard SPA owns `/review/:linkId` (the shell page), so when both
  // are served from one origin the proxied document needs its own path.
  // `/review/:linkId` stays as a direct entry point for API-origin links.
  router.get(['/:linkId', '/:linkId/frame'], async (req: Request, res: Response) => {
    res.setHeader('X-Robots-Tag', 'noindex');

    const linkId = paramString(req.params.linkId);
    if (!linkId) return sendUnavailable(res);

    const link = await sharedLinkRepo.findById(linkId);
    // Enumeration-oracle kill: missing and feedback-disabled are identical.
    if (!link || !link.allowFeedback) {
      return sendUnavailable(res);
    }

    // Password-protected links are NOT proxied here (see file header): the
    // fetch would leak the page ahead of the password gate.
    if (link.passwordHash) {
      return res.status(401).json({
        error: {
          code: 'PASSWORD_REQUIRED',
          message: 'This link is password protected; open it from the dashboard.',
          details: {},
        },
      });
    }

    // Resolve the project's target page URL — the first page of the project.
    const pages = await pageRepo.listByProject(link.projectId);
    const target = pages[0]?.url;
    if (!target) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'This project has no target page.', details: {} },
      });
    }

    try {
      const { response, finalUrl } = await fetchFollowingRedirects(
        target,
        safeFetchImpl,
        assertPublicUrlImpl,
        egressOptions,
      );

      if (response.status < 200 || response.status >= 300) {
        return res.status(502).json({
          error: {
            code: 'UPSTREAM_ERROR',
            message: `Upstream returned status ${response.status}.`,
            details: {},
          },
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/^text\/html\b/i.test(contentType.trim())) {
        return res.status(415).json({
          error: {
            code: 'UNSUPPORTED_CONTENT',
            message: 'Only text/html pages can be reviewed.',
            details: {},
          },
        });
      }

      // Fast-path reject on a declared Content-Length over the cap.
      const declaredLen = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLen) && declaredLen > PROXY_MAX_BYTES) {
        return res.status(413).json({
          error: { code: 'TOO_LARGE', message: 'Page exceeds the 5MB review cap.', details: {} },
        });
      }

      // Streamed read: stops pulling from the socket at the cap, so a target
      // that omits Content-Length and streams an unbounded body can't
      // exhaust memory before the size check.
      const { text: html, truncated } = await readBodyCapped(response, PROXY_MAX_BYTES);
      if (truncated) {
        return res.status(413).json({
          error: { code: 'TOO_LARGE', message: 'Page exceeds the 5MB review cap.', details: {} },
        });
      }

      const origin = new URL(finalUrl).origin + '/';
      const wrapped = injectIntoHtml(html, origin, linkId);

      // Strict CSP on OUR wrapper response. Scripts are limited to our own
      // injected inline overlay (hashless — we allow 'unsafe-inline' for the
      // single injected <script> and the origin's own inline scripts, which
      // the reviewer's browser loads under the injected <base>). frame
      // embedding of THIS response is restricted to same-origin (the
      // dashboard) so the proxy itself can't be reframed by a third party.
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "img-src * data: blob:",
          "style-src * 'unsafe-inline'",
          "script-src 'unsafe-inline' *",
          "font-src * data:",
          `frame-ancestors ${ancestors}`,
          "base-uri *",
          PROXY_SANDBOX,
        ].join('; '),
      );
      res.type('text/html').status(200).send(wrapped);
      return;
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        return res.status(502).json({
          error: {
            code: 'EGRESS_BLOCKED',
            message: 'The target page could not be fetched safely.',
            details: {},
          },
        });
      }
      return res.status(502).json({
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'Failed to fetch the target page.',
          details: {},
        },
      });
    }
  });

  return router;
}
