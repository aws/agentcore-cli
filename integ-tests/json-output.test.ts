import { runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('JSON output structure', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-json-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('create command', () => {
    it('error response has success:false and error string', async () => {
      // 'Test' is a reserved name, so this will fail validation
      const result = await runCLI(['create', '--name', 'Test', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success, 'success should be false').toBe(false);
      expect(typeof json.error, 'error should be a string').toBe('string');
      expect(json.error.length > 0, 'error should not be empty').toBeTruthy();
    });

    it('validation error mentions the issue', async () => {
      const result = await runCLI(['create', '--name', 'Test', '--json'], testDir);
      const json = JSON.parse(result.stdout);

      // Error should mention why 'Test' is invalid (reserved/conflicts)
      expect(
        json.error.toLowerCase().includes('reserved') || json.error.toLowerCase().includes('conflict'),
        `Error should explain the issue: ${json.error}`
      ).toBeTruthy();
    });

    it('missing required options returns error JSON', async () => {
      // Missing --language, --framework, etc without --no-agent
      const result = await runCLI(['create', '--name', 'ValidName', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe('string');
    });

    it('invalid framework returns error JSON', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          'TestProj',
          '--language',
          'Python',
          '--framework',
          'InvalidFramework',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('framework')).toBeTruthy();
    });
  });

  // Note: Success response tests for create are in src/cli/commands/create/create.test.ts
  // Tests for deploy, invoke, add, attach, remove JSON output are in their respective test files
  // as they require a project context to output JSON.
});
