import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runCLI } from '../src/test-utils/index.js';

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
      
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false, 'success should be false');
      assert.strictEqual(typeof json.error, 'string', 'error should be a string');
      assert.ok(json.error.length > 0, 'error should not be empty');
    });

    it('validation error mentions the issue', async () => {
      const result = await runCLI(['create', '--name', 'Test', '--json'], testDir);
      const json = JSON.parse(result.stdout);
      
      // Error should mention why 'Test' is invalid (reserved/conflicts)
      assert.ok(
        json.error.toLowerCase().includes('reserved') || 
        json.error.toLowerCase().includes('conflict'),
        `Error should explain the issue: ${json.error}`
      );
    });

    it('missing required options returns error JSON', async () => {
      // Missing --language, --framework, etc without --no-agent
      const result = await runCLI(['create', '--name', 'ValidName', '--json'], testDir);
      
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.strictEqual(typeof json.error, 'string');
    });

    it('invalid framework returns error JSON', async () => {
      const result = await runCLI([
        'create', '--name', 'TestProj',
        '--language', 'Python',
        '--framework', 'InvalidFramework',
        '--model-provider', 'Bedrock',
        '--memory', 'none',
        '--json'
      ], testDir);
      
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('framework'));
    });
  });

  // Note: Success response tests for create are in src/cli/commands/create/create.test.ts
  // Tests for deploy, invoke, add, attach, remove JSON output are in their respective test files
  // as they require a project context to output JSON.
});
