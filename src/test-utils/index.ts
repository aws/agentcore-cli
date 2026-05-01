/**
 * Shared test utilities for AgentCore CLI tests.
 * Import these helpers instead of duplicating code in each test file.
 */
import { runCLI as runCLIImpl } from './cli-runner.js';
import { expect } from 'vitest';

export { runCLI, spawnAndCollect, cleanSpawnEnv, type RunResult } from './cli-runner.js';
export { createTelemetryHelper, type TelemetryHelper, type TelemetryEntry } from './telemetry-helper.js';
export { exists } from './fs-helpers.js';
export { hasCommand, hasAwsCredentials, prereqs } from './prereqs.js';
export { createTestProject, type TestProject, type CreateTestProjectOptions } from './project-factory.js';
export { readProjectConfig } from './config-reader.js';

export async function runSuccess(args: string[], cwd: string): Promise<Record<string, unknown>> {
  const result = await runCLIImpl(args, cwd);
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

export async function runFailure(args: string[], cwd: string): Promise<Record<string, unknown>> {
  const result = await runCLIImpl(args, cwd);
  expect(result.exitCode).toBe(1);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', false);
  expect(json).toHaveProperty('error');
  return json as Record<string, unknown>;
}

/**
 * Retry an async function up to `times` attempts with a delay between retries.
 */
export async function retry<T>(fn: () => Promise<T>, times: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < times - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

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
