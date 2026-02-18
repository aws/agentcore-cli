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

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [textLoaderPlugin],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: ['src/assets/cdk/test/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integ',
          include: ['integ-tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e-tests/**/*.test.ts'],
          testTimeout: 600000,
          hookTimeout: 600000,
        },
      },
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
    globals: false,
    reporters: ['verbose'],
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
