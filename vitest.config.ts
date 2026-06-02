import { defineConfig } from 'vitest/config';

export default defineConfig({
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
