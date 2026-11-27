// Root ESLint config for the client / shared / mcp workspaces (ESLint 8 classic
// config). `server/` has its own `root: true` config (hexagonal boundary rules)
// and is linted by `npm run lint --workspace server`; it is ignored here.
//
// NOTE: `@typescript-eslint/eslint-plugin` is not installed (only the parser),
// and adding deps is out of scope, so this uses ESLint core rules with the TS
// parser. If the plugin is ever added, swap `eslint:recommended` for
// `plugin:@typescript-eslint/recommended` and drop the core-rule workarounds below.

/** Matches `x.innerHTML`, `x.outerHTML` and `x.insertAdjacentHTML(...)`, assigned or read. */
const HTML_INJECTION = [
  {
    selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]",
    message:
      'Do not use innerHTML/outerHTML/insertAdjacentHTML in client code (XSS); build DOM with el()/setText()/textContent. If truly needed, add an eslint-disable-next-line with a justification.',
  },
  {
    selector: "MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]",
    message: 'Do not use innerHTML/outerHTML/insertAdjacentHTML in client code (XSS).',
  },
];

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { es2022: true, browser: true },
  extends: ['eslint:recommended'],
  ignorePatterns: [
    '**/dist/**',
    '**/node_modules/**',
    'server/**',
    'e2e/**',
    'mobile-sdk/**',
    '.eslintrc.cjs',
  ],
  rules: {
    // TypeScript already checks undefined identifiers (and core `no-undef`
    // false-positives on DOM/ambient types), so tsc is the authority here.
    'no-undef': 'off',
    // Core `no-unused-vars` does not understand TS type positions / overload
    // signatures; use it for locals/imports only and honour the `_` convention.
    'no-unused-vars': [
      'error',
      {
        args: 'none',
        // `_x` convention, plus the `declare global { interface HTMLElement*Map }`
        // augmentations which core no-unused-vars wrongly reports as unused.
        varsIgnorePattern: '^(_|HTMLElement(TagName|Event)Map$)',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      },
    ],
    // Core `no-redeclare` flags TS function overloads; tsc reports real redeclarations.
    'no-redeclare': 'off',
    'no-restricted-syntax': ['error', ...HTML_INJECTION],
  },
  overrides: [
    {
      // Node-only workspace.
      files: ['mcp-server/src/**/*.ts'],
      env: { node: true, browser: false },
    },
    {
      // Shared code runs in both the browser and Node.
      files: ['shared/src/**/*.ts'],
      env: { node: true, browser: true },
    },
    {
      // Tests build fixtures with markup strings and use vitest/node globals; the XSS
      // rule targets shipped client code, not test scaffolding.
      files: ['**/*.test.ts', '**/*.test-d.ts', '**/__tests__/**/*.ts'],
      env: { node: true },
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
