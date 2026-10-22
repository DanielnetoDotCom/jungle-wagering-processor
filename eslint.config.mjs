// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const frameworkPackages = [
  '@nestjs/*',
  '@mikro-orm/*',
  '@aws-sdk/*',
  'pino',
  '@prometheus-io/client',
  'express',
  'pg',
];

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'infra/**', '*.config.mjs'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Never parse money as float.' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Hexagonal boundaries: the domain depends on nothing but itself and pure libraries.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: frameworkPackages, message: 'The domain layer must stay framework-free.' },
            {
              group: [
                '**/application/**',
                '**/infrastructure/**',
                '**/interfaces/**',
                '**/workers/**',
                '**/bootstrap/**',
              ],
              message: 'The domain layer cannot depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Application layer: use cases and ports only; adapters are injected.
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: frameworkPackages, message: 'Use cases talk to ports, not to frameworks.' },
            {
              group: ['**/infrastructure/**', '**/interfaces/**', '**/workers/**', '**/bootstrap/**'],
              message: 'The application layer cannot depend on adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // bun:test types `expect(promise).rejects.*` as void although it returns a
      // promise at runtime; awaiting it is required for the assertion to count.
      '@typescript-eslint/await-thenable': 'off',
    },
  },
  prettier,
);
