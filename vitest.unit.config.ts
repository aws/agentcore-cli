import * as fs from 'fs';
import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    {
      name: 'text-loader',
      transform(code, id) {
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
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/assets/**/*.test.ts'],
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
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/assets/**', 'src/**/*.d.ts'],
    },
  },
});
