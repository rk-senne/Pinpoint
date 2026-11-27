import { defineConfig, type Plugin } from 'vite';

// API origin the dashboard proxies to. `localhost:3001` for `npm run dev`;
// the Compose dashboard sets API_PROXY_TARGET=http://api:3001.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3001';

const proxy = {
  '/api': apiTarget,
  // Realtime: Socket.IO handshake + websocket upgrade.
  '/socket.io': { target: apiTarget, ws: true },
  // Public widget bundle, and the review-link proxy document (the SPA owns
  // /review/:linkId; the proxied page is iframed from /review/:linkId/frame).
  '/widget': apiTarget,
  '^/review/[^/]+/frame': apiTarget,
};

/**
 * Production CSP for the dashboard served by `vite preview` (F9). Inline
 * `<style>`/style="" are used by the templates and the injected theme CSS, so
 * `style-src` keeps 'unsafe-inline'; scripts are first-party only (the Vite
 * build emits no inline scripts). `frame-src 'self'` covers the review-link
 * iframe, which loads the same-origin `/review/:id/frame` proxy.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Same-origin images (local-disk screenshots) and local previews only by
  // default; extra https origins (S3/CDN, avatar hosts) via imageOrigins().
  "img-src 'self' data: blob:",
  // REST and Socket.IO are same-origin behind Caddy ('self' covers ws(s) to
  // the same host in every current browser). No arbitrary socket hosts.
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join('; ');

/** Browser features the dashboard never needs (OWASP HTTP Headers cheat sheet). */
export const DASHBOARD_PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'geolocation=()',
  'gyroscope=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'usb=()',
  'interest-cohort=()', 'browsing-topics=()',
].join(', ');

/** `/review/:linkId/frame` is proxied to the API and must stay framable. */
const REVIEW_FRAME_PATH = /^\/review\/[^/]+\/frame\/?$/;

/**
 * Security headers for every response of the preview server, computed per
 * path. The proxied review frame is exempt from CSP + X-Frame-Options: it
 * carries its own CSP (opaque-origin `sandbox`, `frame-ancestors` allow-list)
 * from the API, and a blanket `X-Frame-Options: DENY` here would stop the
 * dashboard from framing it. (A static `preview.headers` map cannot express
 * that exemption, hence the plugin.)
 */
/**
 * Extra https origins images may load from: the S3/CDN screenshot host and
 * operator-approved avatar/logo hosts (PINPOINT_IMG_ORIGINS, comma-separated).
 * Anything else falls back to initials (avatars) or is hidden (logos), which
 * also stops third-party image hosts from tracking dashboard users.
 */
export function imageOrigins(env: Record<string, string | undefined>): string[] {
  const raw = [env.S3_PUBLIC_BASE_URL, env.S3_ENDPOINT, ...(env.PINPOINT_IMG_ORIGINS ?? '').split(',')];
  const out = new Set<string>();
  for (const v of raw) {
    const t = (v ?? '').trim();
    if (!t) continue;
    try {
      const u = new URL(t);
      if (u.protocol === 'https:' && !u.username && !u.password) out.add(u.origin);
    } catch {
      /* ignore invalid entries */
    }
  }
  return [...out].sort();
}

/** The dashboard CSP with the configured image origins appended to img-src. */
export function buildDashboardCsp(env: Record<string, string | undefined> = {}): string {
  const extra = imageOrigins(env);
  if (extra.length === 0) return DASHBOARD_CSP;
  return DASHBOARD_CSP.replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${extra.join(' ')}`);
}

export function dashboardSecurityHeaders(
  pathname: string,
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': DASHBOARD_PERMISSIONS_POLICY,
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (REVIEW_FRAME_PATH.test(pathname)) return common;
  return {
    ...common,
    'Content-Security-Policy': buildDashboardCsp(env),
    'X-Frame-Options': 'DENY',
    // Isolates the dashboard's browsing context from cross-origin openers.
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

// Preview server only: `vite dev` is deliberately left without a CSP (HMR
// needs inline/eval-ish scripts and a websocket to the dev server).
const previewSecurityHeaders = (): Plugin => ({
  name: 'pinpoint-preview-security-headers',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? '/').split('?', 1)[0] ?? '/';
      for (const [k, v] of Object.entries(dashboardSecurityHeaders(pathname, process.env))) {
        res.setHeader(k, v);
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [previewSecurityHeaders()],
  // The same proxy table serves `vite` (dev) and `vite preview` (the
  // Compose/production-preview container): the dashboard calls the API on
  // its own origin, so cookies stay first-party and no CORS is needed.
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  optimizeDeps: {
    // Pre-bundle the workspace shared package so its CommonJS output is
    // converted to a single ESM module up-front. The shared workspace
    // compiles with `module: Node16` and emits `__exportStar(require(...))`
    // re-exports, which Rollup's CJS plugin cannot statically resolve in
    // production builds. Forcing it through esbuild's CJS→ESM transform
    // here gives the dashboard bundler clean named exports for `signal`,
    // `SEVERITY_COLORS`, etc.
    include: ['@pinpoint/shared'],
    esbuildOptions: {
      // Same transform behavior the bundler will rely on.
      format: 'esm',
    },
  },
  build: {
    commonjsOptions: {
      // The shared workspace lives at `../shared/dist/index.js` relative
      // to the dashboard. By default the CJS plugin only inspects files
      // under `node_modules`; including the workspace path here makes it
      // process the shared package's CommonJS output during the build.
      include: [/shared\/dist/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
