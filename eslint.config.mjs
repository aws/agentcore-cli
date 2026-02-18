import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      security,
    },
    rules: {
      ...importPlugin.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...security.configs.recommended.rules,
      // CLI inherently works with dynamic file paths and Record lookups — these are false positives
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'import/no-unresolved': 'off', // TypeScript handles this
      // Allow intentional unused placeholders like `_unused`
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
  },
  prettier,
  // Relaxed rules for test files
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test-utils/**', 'integ-tests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
    },
  },
  {
    ignores: [
      'dist',
      'node_modules',
      'src/assets',
      'src/schema/llm-compacted',
      'web-harness',
      '.agentcore',
      '**/.agentcore/**',
      '.venv',
      '**/.venv/**',
      '*.config.js',
      '.idea',
      '.vscode',
      '.kiro',
      '.amazonq',
      'coverage',
      '*.log',
      '*.tsbuildinfo',
    ],
  }
);
