import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Deep imports used by the extension to keep zod out of its bundle
      // (`@pinpoint/shared/dist/<mod>.js`) resolve to source under test.
      // Must precede the bare-package alias, which matches by prefix.
      '@pinpoint/shared/dist': fileURLToPath(new URL('./shared/src', import.meta.url)),
      '@pinpoint/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/src/**/*.test.ts', '**/src/**/*.test-d.ts', 'scripts/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'extension/src/__tests__/optionsPage.test.ts',
      'extension/src/__tests__/popupPage.test.ts',
      'dashboard/src/pages/ProjectView.test.ts',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['**/src/**/*.ts'],
      exclude: ['**/src/**/*.test.ts', '**/src/**/*.test-d.ts', '**/dist/**', '**/node_modules/**'],
      // Ratchet: the measured floor when coverage was first enforced in CI
      // (Nov 2026: statements 71.7, branches 64.4, functions 69.1, lines 73.9).
      // Raise these as coverage improves; never lower them.
      thresholds: {
        lines: 73,
        branches: 64,
        functions: 69,
        statements: 71,
      },
    },
  },
});
