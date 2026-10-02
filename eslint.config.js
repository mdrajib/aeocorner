import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  setTimeout: 'readonly',
  CustomEvent: 'readonly',
  HTMLDialogElement: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'src/web/public/build/**',
      'src/web/public/vendor/**',
      'src/db/generated/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser-side code: our own scripts, and the callbacks Playwright runs inside the page.
    files: ['src/web/public/js/**/*.js', 'tests/e2e/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
  {
    // Tenant isolation, runtime layer (DATABASE_SCHEMA §6): Prisma and raw SQL live in src/db only. Everything
    // else talks to the repositories exported by src/db/index.js, which bind every query to an organization.
    files: ['**/*.js'],
    ignores: ['src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/*', '**/db/generated/**', '**/generated/client/**'],
              message:
                'Prisma is used only inside src/db. Import the repositories from src/db/index.js.',
            },
            {
              group: ['**/db/repos/**', '**/db/client.js'],
              message: 'Use createDb() from src/db/index.js, not a repository file.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^[$](queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|transaction|connect|disconnect)$/]',
          message: 'Raw SQL and transactions belong in src/db (a repository function).',
        },
        {
          selector: "MemberExpression[property.name='_prisma']",
          message: 'The raw Prisma client is private to src/db.',
        },
      ],
    },
  },
  eslintConfigPrettier,
];
