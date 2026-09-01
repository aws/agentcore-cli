import { containsSensitiveTestOutput, sensitiveEnvironmentValues } from './src/test-utils/test-output-redaction';
import * as fs from 'fs';
import * as path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Shared text-loader plugin for loading markdown and llm-compacted files as text
 */
const textLoaderPlugin = {
  name: 'text-loader',
  transform(code: string, id: string) {
    if (id.includes('llm-compacted') && id.endsWith('.ts')) {
      const text = fs.readFileSync(id, 'utf-8');
      return {
        code: `export default ${JSON.stringify(text)};`,
        map: null,
      };
    }
    if (id.endsWith('.md')) {
      const text = fs.readFileSync(id, 'utf-8');
      return {
        code: `export default ${JSON.stringify(text)};`,
        map: null,
      };
    }
  },
};

const testSecretValues = sensitiveEnvironmentValues();

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@aws/agentcore-cdk': path.resolve(__dirname, './node_modules/@aws/agentcore-cdk/dist/index.js'),
    },
  },
  plugins: [textLoaderPlugin],
  test: {
    deps: {
      optimizer: {
        ssr: {
          include: ['@aws-sdk/*', '@smithy/*', 'zod', 'commander'],
        },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: ['src/assets/cdk/test/*.test.ts', 'src/tui-harness/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integ',
          include: ['integ-tests/**/*.test.ts'],
          exclude: ['integ-tests/tui/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e-tests/**/*.test.ts'],
          testTimeout: 600000,
          hookTimeout: 600000,
          globalSetup: ['./e2e-tests/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'tui',
          include: ['integ-tests/tui/**/*.test.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
          setupFiles: ['./integ-tests/tui/setup.ts'],
        },
      },
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
    globals: false,
    reporters: ['verbose'],
    onConsoleLog(log) {
      return !containsSensitiveTestOutput(log, testSecretValues);
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/assets/**',
        'src/test-utils/**',
        'src/**/*.d.ts',
        '**/index.ts',
      ],
    },
  },
});
