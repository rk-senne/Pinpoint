import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/embed/widget.ts'),
      name: 'PinpointWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    outDir: 'dist/widget',
    emptyOutDir: true,
  },
});
