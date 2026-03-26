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

// ---------------------------------------------------------------------------
// MCP harness build — opt-in via BUILD_HARNESS=1
//
// The TUI harness is dev-only tooling for AI agents and integration tests.
// It is NOT shipped to end users. Build it separately with:
//   BUILD_HARNESS=1 node esbuild.config.mjs
//   npm run build:harness
// ---------------------------------------------------------------------------
const mcpEntryPoint = './src/tui-harness/mcp/index.ts';

if (process.env.BUILD_HARNESS === '1' && fs.existsSync(mcpEntryPoint)) {
  await esbuild.build({
    entryPoints: [mcpEntryPoint],
    outfile: './dist/mcp-harness/index.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    banner: {
      js: [
        '#!/usr/bin/env node',
        `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
      ].join('\n'),
    },
    // node-pty is a native C++ addon and cannot be bundled.
    // @xterm/headless is CJS-only (no ESM exports map) — esbuild's CJS-to-ESM
    // conversion mangles its default export at runtime, so let Node handle it.
    // fsevents is macOS-only optional native module.
    // express is CJS-heavy (deeply nested require chains) — let Node.js resolve
    // it at runtime from node_modules instead of bundling.
    external: ['fsevents', 'node-pty', '@xterm/headless', 'express'],
    plugins: [textLoaderPlugin],
  });

  // Make executable
  fs.chmodSync('./dist/mcp-harness/index.mjs', '755');

  console.log('MCP harness build complete: dist/mcp-harness/index.mjs');
} else if (process.env.BUILD_HARNESS === '1') {
  console.log(`MCP harness build skipped: entry point ${mcpEntryPoint} does not exist yet`);
}
