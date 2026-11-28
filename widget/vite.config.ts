import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Pinpoint',
      formats: ['iife'],
      fileName: () => 'pinpoint-widget.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    // Vite 8's built-in Oxc minifier — no optional esbuild/terser dependency.
    // Console calls are intentionally NOT dropped: the widget's console
    // capture (Mission C2) passes through to the host console, and the
    // init-time misconfiguration errors are meant for integrators.
    minify: 'oxc',
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
});
