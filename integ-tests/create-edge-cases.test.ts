/* eslint-disable security/detect-non-literal-fs-filename */
import { exists, prereqs, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!prereqs.npm || !prereqs.git)('integration: create edge cases', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-edge-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('reserved names', () => {
    it('rejects reserved name "Test"', async () => {
      const result = await runCLI(['create', '--name', 'Test', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe('string');
      expect(
        json.error.toLowerCase().includes('reserved') || json.error.toLowerCase().includes('conflict'),
        `Error should mention reserved/conflict: ${json.error}`
      ).toBeTruthy();
    });

    it('rejects reserved name "bedrock"', async () => {
      const result = await runCLI(['create', '--name', 'bedrock', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe('string');
    });
  });

  describe('invalid framework/provider combos', () => {
    it('rejects GoogleADK with Bedrock provider', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          `GadkBr${Date.now().toString().slice(-6)}`,
          '--language',
          'Python',
          '--framework',
          'GoogleADK',
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
      expect(typeof json.error).toBe('string');
    });

    it('rejects OpenAIAgents with Anthropic provider', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          `OaiAn${Date.now().toString().slice(-6)}`,
          '--language',
          'Python',
          '--framework',
          'OpenAIAgents',
          '--model-provider',
          'Anthropic',
          '--memory',
          'none',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe('string');
    });

    it('rejects invalid framework name', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          `BadFw${Date.now().toString().slice(-6)}`,
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
    });
  });

  describe('flag interactions', () => {
    it('--defaults creates project with default settings', async () => {
      const name = `Def${Date.now().toString().slice(-6)}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--json'], testDir);

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.projectPath).toBeTruthy();
    });

    it('--dry-run shows what would be created without writing files', async () => {
      const name = `DryRun${Date.now().toString().slice(-6)}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--dry-run', '--json'], testDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.dryRun).toBe(true);

      // Project directory should NOT exist
      const projectExists = await exists(join(testDir, name));
      expect(projectExists, 'Dry run should not create project directory').toBe(false);
    });

    it('--skip-git creates project without .git directory', async () => {
      const name = `NoGit${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'create',
          '--name',
          name,
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--skip-git',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const gitExists = await exists(join(json.projectPath, '.git'));
      expect(gitExists, '.git should not exist when --skip-git is used').toBe(false);
    });
  });
});
