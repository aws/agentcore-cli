/* eslint-disable security/detect-non-literal-fs-filename */
import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Overwrite a file's content for the duration of `fn`, then restore the
 * original contents — even if `fn` throws. Used to inject a broken config
 * into the shared project fixture without polluting later tests.
 */
async function withTempFileContent(
  projectPath: string,
  relPath: string,
  newContent: string,
  fn: () => Promise<void>
): Promise<void> {
  const full = join(projectPath, relPath);
  const original = await readFile(full, 'utf-8');
  try {
    await writeFile(full, newContent, 'utf-8');
    await fn();
  } finally {
    await writeFile(full, original, 'utf-8');
  }
}

describe('integration: validate command', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('validates a valid project successfully', async () => {
    const result = await runCLI(['validate'], project.projectPath);

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    // validate outputs "Valid" on success (Ink text render)
    expect(result.stdout.toLowerCase()).toContain('valid');
  });

  it('reports error for corrupted agentcore.json', async () => {
    const configPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const { readFile } = await import('node:fs/promises');
    const originalContent = await readFile(configPath, 'utf-8');

    try {
      await writeFile(configPath, '{invalid json!!!', 'utf-8');

      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode).toBe(1);
      // Error message should appear in stdout (Ink render) or stderr
      const output = result.stdout + result.stderr;
      expect(output.length, 'Should produce error output').toBeGreaterThan(0);
    } finally {
      // Restore original config so other tests aren't affected
      await writeFile(configPath, originalContent, 'utf-8');
    }
  });

  it('reports error when run outside a project', async () => {
    const emptyDir = join(tmpdir(), `agentcore-no-project-${randomUUID()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      const result = await runCLI(['validate'], emptyDir);

      expect(result.exitCode).toBe(1);
      // Error message should appear somewhere in output
      const output = result.stdout + result.stderr;
      expect(output.length, 'Should produce error output').toBeGreaterThan(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('reports error for corrupted aws-targets.json', async () => {
    await withTempFileContent(project.projectPath, 'agentcore/aws-targets.json', '{invalid json!!!', async () => {
      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('aws-targets.json');
    });
  });

  it('reports error for corrupted deployed-state.json', async () => {
    // Fresh projects don't include deployed-state.json. The path resolver
    // places it at `<projectRoot>/agentcore/.cli/deployed-state.json`
    // (see src/lib/schemas/io/path-resolver.ts:getStatePath).
    const stateDir = join(project.projectPath, 'agentcore', '.cli');
    const statePath = join(stateDir, 'deployed-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, '{invalid}', 'utf-8');

      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode).toBe(1);
      // formatError labels this file as `.cli/state.json` regardless of actual
      // filename (see src/cli/commands/validate/action.ts).
      const output = result.stdout + result.stderr;
      expect(output).toContain('.cli/state.json');
    } finally {
      await rm(statePath, { force: true });
    }
  });

  it('reports error for empty aws-targets.json', async () => {
    await withTempFileContent(project.projectPath, 'agentcore/aws-targets.json', '', async () => {
      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('aws-targets.json');
    });
  });

  it('reports error for invalid schema in aws-targets.json', async () => {
    const badSchema = JSON.stringify([{ name: 123, account: true, region: [] }]);
    await withTempFileContent(project.projectPath, 'agentcore/aws-targets.json', badSchema, async () => {
      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      // ConfigValidationError emits a zod issue summary; we don't pin exact text.
      expect(output.length, 'Should produce error output').toBeGreaterThan(0);
    });
  });
});
