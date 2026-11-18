import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

// Wires the Manifest V3 manifest.json through @crxjs/vite-plugin so Vite
// emits a Chrome Web Store-loadable dist/. Tasks 23.2-23.5 swap the build
// script, add icons, narrow permissions, and verify the produced bundle.
//
// `__PINPOINT_API_ORIGIN__` is the compile-time API origin. It is sourced
// from the `VITE_PINPOINT_API_ORIGIN` env var at build time (default
// `http://localhost:3001`) and consumed by `src/lib/serverOrigin.ts` as the
// build-time fallback below a user-configured Server URL. Define-replacing a
// bare identifier requires the value to be JSON-stringified so Vite inlines
// a string literal.
const apiOrigin =
  process.env.VITE_PINPOINT_API_ORIGIN || 'http://localhost:3001';

export default defineConfig({
  define: {
    __PINPOINT_API_ORIGIN__: JSON.stringify(apiOrigin),
  },
  plugins: [crx({ manifest })],
  optimizeDeps: {
    // Pre-bundle the workspace shared package so its CommonJS output is
    // converted to ESM up-front. The shared workspace compiles with
    // `module: Node16` and emits `__exportStar(require(...))` re-exports,
    // which Rollup's CJS plugin cannot statically resolve. Mirrors the
    // dashboard's vite.config.ts so the extension picks up named exports
    // like `themeCss`, `SEVERITY_COLORS`, `signal`, etc.
    include: ['@pinpoint/shared'],
    esbuildOptions: {
      format: 'esm',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    commonjsOptions: {
      // The shared workspace lives at `../shared/dist/index.js`. By default
      // the CJS plugin only inspects files under `node_modules`; including
      // the workspace path here makes it process the shared package's
      // CommonJS output during the production build.
      include: [/shared\/dist/, /node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      // CRXJS resolves manifest entries (background, content_scripts) itself,
      // so no manual `input` entries are needed here.
    },
  },
});
