// Hexagonal-architecture boundary rules (Phase 1.5 / task 4.5.2).
//
// We use ESLint 8's classic config (.eslintrc.cjs) so it lives next to
// `package.json` without needing the new flat-config migration. The
// `eslint-plugin-import` `no-restricted-paths` rule is the boundary
// enforcement called out in the design doc; CI fails the build on any
// violation.
//
// Path resolution is relative to this file (`server/`), so `./src/domain`
// is the canonical domain root.

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['import'],
  settings: {
    'import/resolver': {
      // The codebase uses NodeNext module resolution with `.js` import
      // suffixes that point to TypeScript sources. The TypeScript
      // resolver knows how to map both `./foo` and `./foo.js` to
      // `./foo.ts` so `no-restricted-paths` can match adapter modules
      // imported from domain code with the `.js` extension.
      typescript: {
        project: './tsconfig.json',
      },
      node: {
        extensions: ['.ts', '.tsx', '.js', '.cjs', '.mjs'],
      },
    },
  },
  ignorePatterns: ['dist/**', 'node_modules/**', '.eslintrc.cjs'],
  rules: {
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // 1. Domain code may not import adapters.
          {
            target: './src/domain',
            from: './src/adapters',
            message:
              'Domain code must not import adapters. Depend on a port interface declared under domain/<aggregate>/ports/ instead.',
          },

          // 2. Domain code may not import the composition root.
          {
            target: './src/domain',
            from: './src/composition',
            message: 'Domain code must not import the composition root.',
          },

          // 3. Inbound adapters and outbound adapters may not import each
          //    other directly. They communicate exclusively through use
          //    cases wired by the composition root.
          {
            target: './src/adapters/inbound',
            from: './src/adapters/outbound',
            message:
              'Inbound adapters must not import outbound adapters directly. Both layers depend on domain ports; the composition root wires them together.',
          },
          {
            target: './src/adapters/outbound',
            from: './src/adapters/inbound',
            message:
              'Outbound adapters must not import inbound adapters. Both layers depend on domain ports; the composition root wires them together.',
          },
        ],
      },
    ],

    // 4. Forbid every restricted infrastructure package from the domain
    //    layer. `eslint-plugin-import`'s `no-restricted-paths` only
    //    handles workspace-relative paths, so the package list is
    //    enforced via `no-restricted-imports` scoped to `./src/domain/**`
    //    via the `overrides` block below.
  },
  overrides: [
    {
      files: ['src/domain/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'express', message: 'Domain code must not import express.' },
              { name: 'socket.io', message: 'Domain code must not import socket.io.' },
              { name: 'knex', message: 'Domain code must not import knex.' },
              { name: 'pg', message: 'Domain code must not import pg.' },
              { name: 'bcrypt', message: 'Domain code must not import bcrypt; depend on PasswordHasher.' },
              { name: 'jsonwebtoken', message: 'Domain code must not import jsonwebtoken; depend on TokenIssuer.' },
              { name: 'nodemailer', message: 'Domain code must not import nodemailer; depend on Mailer.' },
              { name: 'aws-sdk', message: 'Domain code must not import aws-sdk; depend on ScreenshotStore.' },
              { name: 'pino', message: 'Domain code must not import pino; depend on Logger.' },
              { name: 'pino-http', message: 'Domain code must not import pino-http.' },
            ],
            patterns: [
              { group: ['@aws-sdk/*'], message: 'Domain code must not import @aws-sdk/* packages; depend on ScreenshotStore.' },
            ],
          },
        ],
      },
    },
  ],
};
