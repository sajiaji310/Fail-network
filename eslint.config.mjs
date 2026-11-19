import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      // .next / .next-dev / .next-serve / .next-dev2 …（构建产物，随时可能换名字）
      '.next*',
      '.next*/**',
      'next-env.d.ts',
      'evals/dataset/**',
      'evals/results/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'scripts/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 13.2：禁止 console.log，统一走 lib/logger
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // 13.1：禁止 any
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // CLI 脚本允许输出到终端
    files: ['scripts/**/*.ts', 'evals/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // 构建期 Node 脚本（.mjs）
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
);
