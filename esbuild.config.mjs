import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { createRequire } from 'module';

// Stub plugin for optional dev dependencies
const optionalDepsPlugin = {
  name: 'optional-deps',
  setup(build) {
    // Stub react-devtools-core (only used when DEV=true)
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'optional-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'optional-stub' }, () => ({
      contents: `export default { initialize: () => {}, connectToDevTools: () => {} };`,
      loader: 'js',
    }));
  },
};

// Text loader plugin for embedding files
const textLoaderPlugin = {
  name: 'text-loader',
  setup(build) {
    // Handle .md and .txt files as text
    build.onLoad({ filter: /\.(md|txt)$/ }, async args => {
      const text = await fs.promises.readFile(args.path, 'utf8');
      return {
        contents: `export default ${JSON.stringify(text)};`,
        loader: 'js',
      };
    });
    // Handle .ts files in llm-compacted as text
    build.onLoad({ filter: /llm-compacted[/\\].*\.ts$/ }, async args => {
      const text = await fs.promises.readFile(args.path, 'utf8');
      return {
        contents: `export default ${JSON.stringify(text)};`,
        loader: 'js',
      };
    });
  },
};

await esbuild.build({
  entryPoints: ['./src/cli/index.ts'],
  outfile: './dist/cli/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  // Inject require shim for ESM compatibility with CommonJS dependencies
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  external: ['fsevents', '@aws-cdk/toolkit-lib'],
  plugins: [optionalDepsPlugin, textLoaderPlugin],
});

// Make executable
fs.chmodSync('./dist/cli/index.mjs', '755');

console.log('CLI build complete: dist/cli/index.mjs');
