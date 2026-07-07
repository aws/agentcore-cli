/* eslint-disable security/detect-non-literal-fs-filename */
import { createTelemetryHelper, createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('integration: validate command', () => {
  let project: TestProject;
  const telemetry = createTelemetryHelper();

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  afterEach(() => {
    telemetry.clearEntries();
  });

  afterAll(async () => {
    telemetry.destroy();
    await project.cleanup();
  });

  it('validates a valid project successfully', async () => {
    const result = await runCLI(['validate'], project.projectPath, { env: telemetry.env });

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    // validate outputs "Valid" on success (Ink text render)
    expect(result.stdout.toLowerCase()).toContain('valid');
    telemetry.assertMetricEmitted({ command: 'validate', exit_reason: 'success' });
  });

  it('reports error for corrupted agentcore.json', async () => {
    const configPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const { readFile } = await import('node:fs/promises');
    const originalContent = await readFile(configPath, 'utf-8');

    try {
      await writeFile(configPath, '{invalid json!!!', 'utf-8');

      const result = await runCLI(['validate'], project.projectPath, { env: telemetry.env });

      expect(result.exitCode).toBe(1);
      // Error message should appear in stdout (Ink render) or stderr
      const output = result.stdout + result.stderr;
      expect(output.length, 'Should produce error output').toBeGreaterThan(0);
      telemetry.assertMetricEmitted({ command: 'validate', exit_reason: 'failure' });
    } finally {
      // Restore original config so other tests aren't affected
      await writeFile(configPath, originalContent, 'utf-8');
    }
  });

  it('reports error when run outside a project', async () => {
    const emptyDir = join(tmpdir(), `agentcore-no-project-${randomUUID()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      const result = await runCLI(['validate'], emptyDir, { env: telemetry.env });

      expect(result.exitCode).toBe(1);
      // Error message should appear somewhere in output
      const output = result.stdout + result.stderr;
      expect(output.length, 'Should produce error output').toBeGreaterThan(0);
      telemetry.assertMetricEmitted({ command: 'validate', exit_reason: 'failure' });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
