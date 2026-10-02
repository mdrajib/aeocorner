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
  eslintConfigPrettier,
];
