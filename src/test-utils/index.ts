/**
 * Shared test utilities for AgentCore CLI tests.
 * Import these helpers instead of duplicating code in each test file.
 */

export { runCLI, type RunResult } from './cli-runner.js';
export { exists } from './fs-helpers.js';
export { hasCommand, hasAwsCredentials, prereqs } from './prereqs.js';
export { createTestProject, type TestProject, type CreateTestProjectOptions } from './project-factory.js';
export { readProjectConfig } from './config-reader.js';

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Parse JSON from CLI output, handling ANSI codes and whitespace.
 * @throws Error if output is not valid JSON
 */
export function parseJsonOutput(output: string): unknown {
  const cleaned = stripAnsi(output).trim();
  if (!cleaned) {
    throw new Error('Empty output, cannot parse JSON');
  }
  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    throw new Error(`Failed to parse JSON from output: ${cleaned.slice(0, 100)}...`);
  }
}
