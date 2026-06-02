import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@pinpoint/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['**/src/**/*.test.ts', '**/src/**/*.test-d.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'extension/src/__tests__/optionsPage.test.ts',
      'extension/src/__tests__/popupPage.test.ts',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['**/src/**/*.ts'],
      exclude: ['**/src/**/*.test.ts', '**/src/**/*.test-d.ts', '**/dist/**', '**/node_modules/**'],
      thresholds: {
        lines: 70,
        branches: 65,
        functions: 70,
        statements: 70,
      },
    },
  },
});
