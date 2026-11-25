import { defineConfig } from 'vite';

/**
 * Safari-only second pass of `npm run build:safari` (see
 * scripts/safari-manifest.mjs). Safari rejects `background.type: "module"`
 * and its content scripts cannot reliably `import()` web-accessible chunks,
 * so the background script and the content script are re-bundled here as
 * self-contained classic IIFE files (`background.js`, `content.js`) written
 * next to the CRXJS output in `dist-safari/`. Selected with
 * `SAFARI_ENTRY=background|content`.
 */
const entry = process.env.SAFARI_ENTRY;
if (entry !== 'background' && entry !== 'content') {
  throw new Error('SAFARI_ENTRY must be "background" or "content"');
}

const apiOrigin = process.env.VITE_PINPOINT_API_ORIGIN || 'http://localhost:3001';

export default defineConfig({
  define: {
    __PINPOINT_API_ORIGIN__: JSON.stringify(apiOrigin),
  },
  plugins: [
    {
      // Same eval-free rewrite as vite.config.ts (engine.io-client).
      name: 'pinpoint:no-function-constructor',
      enforce: 'pre',
      transform(code, id) {
        if (!/engine\.io-client[\\/].*globals\.js$/.test(id)) return null;
        return code.replace(/Function\((["'])return this\1\)\(\)/g, 'globalThis');
      },
    },
  ],
  optimizeDeps: { include: ['@pinpoint/shared'], esbuildOptions: { format: 'esm' } },
  build: {
    outDir: 'dist-safari',
    emptyOutDir: false,
    minify: true,
    commonjsOptions: {
      include: [/shared\/dist/, /node_modules/],
      transformMixedEsModules: true,
    },
    lib: {
      entry: `src/${entry}.ts`,
      formats: ['iife'],
      name: entry === 'background' ? 'PinpointBackground' : 'PinpointContent',
      fileName: () => `${entry}.js`,
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
