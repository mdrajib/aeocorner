import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  setTimeout: 'readonly',
  CustomEvent: 'readonly',
  HTMLDialogElement: 'readonly',
  Event: 'readonly',
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
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        TextDecoder: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The PM2 process file is CommonJS: PM2 loads it with require().
    files: ['deploy/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
  },
  {
    // Browser-side code: our own scripts, and the callbacks Playwright runs inside the page.
    files: ['src/web/public/js/**/*.js', 'src/web/editor/**/*.js', 'tests/e2e/**/*.js'],
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
  {
    // A transaction in a repository goes through transaction() so that a deadlock (InnoDB abandoning one of two
    // transactions that wait on each other) is retried instead of becoming a failed request.
    files: ['src/db/repos/**/*.js'],
    ignores: ['**/*.test.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='$transaction']",
          message:
            "Use transaction(prisma, async (tx) => …) from '../transaction.js': it retries deadlocks.",
        },
      ],
    },
  },
  eslintConfigPrettier,
];
