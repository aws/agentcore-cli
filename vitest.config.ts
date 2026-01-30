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
        // Handle .ts files in llm-compacted as text
        if (id.includes('llm-compacted') && id.endsWith('.ts')) {
          const text = fs.readFileSync(id, 'utf-8');
          return {
            code: `export default ${JSON.stringify(text)};`,
            map: null,
          };
        }
        // Handle .md files as text
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
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts', 'integ-tests/**/*.test.ts'],
    exclude: ['src/assets/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 60000,
    globals: false,
    reporters: ['verbose'],
  },
});
