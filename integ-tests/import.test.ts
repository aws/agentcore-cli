/* eslint-disable security/detect-non-literal-fs-filename */
import { type TestProject, createTestProject, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tests for `agentcore import` error paths that run without AWS credentials.
 * AWS calls only fire when the parsed YAML contains a physical `agent_id` or
 * `memory_id` — all fixtures here omit those fields.
 *
 * Note: `agentcore import --source ...` does not expose a `--json` flag, so
 * assertions read from the combined stdout/stderr stream.
 */
describe('integration: import command', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      name: 'ImportTest',
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  }, 120_000);

  afterAll(async () => {
    await project.cleanup();
  });

  it('returns error when source file does not exist', async () => {
    const missingPath = `/tmp/agentcore-missing-${randomUUID()}.yaml`;
    const result = await runCLI(['import', '--source', missingPath, '--yes'], project.projectPath);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // src/cli/commands/import/command.ts logs `Source file not found: <path>`
    // via console.error before calling handleImport.
    expect(output).toMatch(/not found|ENOENT|no such file/i);
  });

  it('returns error when YAML parses to zero agents', async () => {
    // A comment-only YAML parses cleanly but yields { agents: [] }. handleImport
    // then returns `No agents found in the YAML config` (see actions.ts step 3).
    const brokenPath = join(project.projectPath, 'broken.yaml');
    await writeFile(brokenPath, '# comment only\n', 'utf-8');

    const result = await runCLI(['import', '--source', brokenPath, '--yes'], project.projectPath);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/No agents|agents/i);
  });
});
