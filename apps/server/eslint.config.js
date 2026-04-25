import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['drizzle/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Server source — node globals; warn on console (sets up for pino, item 24)
  // and on unused vars (with leading-underscore opt-out). `any` stays a warning
  // rather than an error: existing call sites use it deliberately as Elysia /
  // WS framework escape hatches (`ws.data as any` for plugin context, etc.) —
  // making it warn surfaces new uses without blocking existing patterns.
  // Empty catch is allowed because soft-fail listener-isolation is a
  // documented pattern (see core-beliefs #7 and presence.ts emit fan-out).
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Tests + CLI scripts may use console freely — stdout output is the point.
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
