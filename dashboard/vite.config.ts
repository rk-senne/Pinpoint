import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
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
