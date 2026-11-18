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
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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
export function dashboardSecurityHeaders(pathname: string): Record<string, string> {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (REVIEW_FRAME_PATH.test(pathname)) return common;
  return {
    ...common,
    'Content-Security-Policy': DASHBOARD_CSP,
    'X-Frame-Options': 'DENY',
  };
}

// Preview server only: `vite dev` is deliberately left without a CSP (HMR
// needs inline/eval-ish scripts and a websocket to the dev server).
const previewSecurityHeaders = (): Plugin => ({
  name: 'pinpoint-preview-security-headers',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? '/').split('?', 1)[0] ?? '/';
      for (const [k, v] of Object.entries(dashboardSecurityHeaders(pathname))) {
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
