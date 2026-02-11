import { exists, runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('create command', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('--no-agent', () => {
    it('creates project structure', async () => {
      const name = `Proj${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir);

      expect(result.exitCode, `stderr: ${result.stderr}, stdout: ${result.stdout}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(await exists(json.projectPath), 'Project should exist').toBeTruthy();
      expect(await exists(join(json.projectPath, 'agentcore')), 'agentcore/ should exist').toBeTruthy();
    });

    it('rejects reserved names', async () => {
      const result = await runCLI(['create', '--name', 'Test', '--no-agent', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('conflicts')).toBeTruthy();
    });
  });

  describe('with agent', () => {
    it('creates project with agent', async () => {
      const name = `Agent${Date.now()}`;
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
          '--json',
        ],
        testDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.agentName).toBe(name);
      expect(await exists(join(json.projectPath, 'app', name))).toBeTruthy();
    });

    it('requires all options without --no-agent', async () => {
      const result = await runCLI(['create', '--name', 'Incomplete', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });

    it('validates framework', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          'BadFW',
          '--language',
          'Python',
          '--framework',
          'NotReal',
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

    it('sets default namespaces for longAndShortTerm memory', async () => {
      const name = `MemNs${Date.now()}`;
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
          'longAndShortTerm',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify namespaces are set for each strategy
      const projectSpec = JSON.parse(await readFile(join(json.projectPath, 'agentcore/agentcore.json'), 'utf-8'));
      const memory = projectSpec.memories[0];

      const semantic = memory?.strategies?.find((s: { type: string }) => s.type === 'SEMANTIC');
      expect(semantic?.namespaces).toEqual(['/users/{actorId}/facts']);

      const userPref = memory?.strategies?.find((s: { type: string }) => s.type === 'USER_PREFERENCE');
      expect(userPref?.namespaces).toEqual(['/users/{actorId}/preferences']);

      const summarization = memory?.strategies?.find((s: { type: string }) => s.type === 'SUMMARIZATION');
      expect(summarization?.namespaces).toEqual(['/summaries/{actorId}/{sessionId}']);
    });
  });

  describe('--defaults', () => {
    it('creates project with defaults', async () => {
      const name = `Defaults${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--json'], testDir);

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(await exists(join(testDir, name))).toBeTruthy();
    });
  });

  describe('--dry-run', () => {
    it('shows files without creating', async () => {
      const name = `DryRun${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--dry-run'], testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('would create') || result.stdout.includes('Dry run')).toBeTruthy();
      expect(await exists(join(testDir, name)), 'Should not create directory').toBe(false);
    });
  });

  describe('--skip-git', () => {
    it('skips git initialization', async () => {
      const name = `NoGit${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--skip-git', '--json'], testDir);

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(await exists(join(testDir, name, '.git')), 'Should not have .git').toBe(false);
    });
  });

  describe('--output-dir', () => {
    it('creates in specified directory', async () => {
      const name = `OutDir${Date.now()}`;
      const customDir = join(testDir, 'custom-output');
      const result = await runCLI(
        ['create', '--name', name, '--defaults', '--output-dir', customDir, '--json'],
        testDir
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(await exists(join(customDir, name)), 'Should create in custom dir').toBeTruthy();
    });
  });

  describe('existing folder', () => {
    it('rejects when folder already exists', async () => {
      const name = `Existing${Date.now()}`;
      // Create the folder first
      await mkdir(join(testDir, name), { recursive: true });

      const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });
  });

  describe('no flags', () => {
    it('launches TUI when no flags provided', async () => {
      const result = await runCLI(['create'], testDir);

      // CLI mode would show "--name is required" error in stderr
      // TUI mode does not - it launches the interactive wizard
      expect(result.stderr).not.toContain('--name is required');
    });
  });
});
