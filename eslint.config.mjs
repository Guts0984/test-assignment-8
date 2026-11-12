import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noClasses = {
  selector: 'ClassDeclaration, ClassExpression',
  message: 'Classes are allowed only in apps/api (NestJS). Use functions and plain objects.',
};

export default tseslint.config(
  {
    ignores: [
      '**/.pnpm-store/**',
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // @ts-ignore is forbidden unless it carries a justification of at least 10 chars.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': ['error', noClasses],
    },
  },
  {
    // Plain Node scripts (CI/test tooling).
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // NestJS is class-based by design.
    files: ['apps/api/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
