/**
 * Re-exports test helpers from the canonical location in src/.
 *
 * The canonical implementation of createMinimalProjectDir lives in
 * src/tui-harness/helpers.ts. This file re-exports it so
 * that integ-tests/tui/ test files can import from a local path
 * (`./helpers.js`) without reaching into src/.
 */

export { createMinimalProjectDir } from '../../src/tui-harness/helpers.js';

export type { CreateMinimalProjectDirOptions, MinimalProjectDirResult } from '../../src/tui-harness/helpers.js';
