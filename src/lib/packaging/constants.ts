export const NODE_RUNTIME_REGEX = /NODE_(\d+)/;

export const NODE_CJS_BANNER = 'const importMetaUrl = require("url").pathToFileURL(__filename).href;';

export const DYNAMIC_REQUIRE_PACKAGES = [
  '@fastify/sse',
  '@fastify/websocket',
  'duplexify',
  'end-of-stream',
  'fastify-plugin',
  'inherits',
  'once',
  'readable-stream',
  'safe-buffer',
  'stream-shift',
  'string_decoder',
  'util-deprecate',
  'wrappy',
  'ws',
];
