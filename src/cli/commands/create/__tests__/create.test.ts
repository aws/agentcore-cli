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

    it('creates project-only scaffold with --project-name and no --name', async () => {
      const projectName = `ProjOnly${Date.now()}`;
      const result = await runCLI(['create', '--project-name', projectName, '--no-agent', '--json'], testDir);

      expect(result.exitCode, `stderr: ${result.stderr}, stdout: ${result.stdout}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.projectPath).toMatch(new RegExp(`/${projectName}$`));
      expect(await exists(join(json.projectPath, 'agentcore'))).toBeTruthy();
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
      // --framework triggers the agent path, which requires --language, --model-provider, etc.
      const result = await runCLI(['create', '--name', 'Incomplete', '--framework', 'Strands', '--json'], testDir);

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

      const episodic = memory?.strategies?.find((s: { type: string }) => s.type === 'EPISODIC');
      expect(episodic, 'EPISODIC strategy should exist in longAndShortTerm').toBeTruthy();
      expect(episodic?.namespaces).toEqual(['/episodes/{actorId}/{sessionId}']);
      expect(episodic?.reflectionNamespaces).toEqual(['/episodes/{actorId}']);
    });

    it('uses --project-name for project and --name for agent resource', async () => {
      const projectName = `AgentProj${Date.now().toString().slice(-6)}`;
      const agentName = `AgentResource${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const result = await runCLI(
        [
          'create',
          '--project-name',
          projectName,
          '--name',
          agentName,
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--skip-git',
          '--skip-install',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.projectPath).toMatch(new RegExp(`/${projectName}$`));
      expect(json.agentName).toBe(agentName);
      expect(await exists(join(json.projectPath, 'app', agentName))).toBeTruthy();

      const projectSpec = JSON.parse(await readFile(join(json.projectPath, 'agentcore/agentcore.json'), 'utf-8'));
      expect(projectSpec.name).toBe(projectName);
      expect(projectSpec.runtimes[0].name).toBe(agentName);
    });
  });

  describe('with harness', () => {
    it('uses --project-name for project and --name for harness resource', async () => {
      const projectName = `HarnessProj${Date.now().toString().slice(-6)}`;
      const harnessName = `HarnessResource${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const result = await runCLI(
        ['create', '--project-name', projectName, '--name', harnessName, '--skip-git', '--skip-install', '--json'],
        testDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.projectPath).toMatch(new RegExp(`/${projectName}$`));
      expect(await exists(join(json.projectPath, 'app', harnessName, 'harness.json'))).toBeTruthy();

      const projectSpec = JSON.parse(await readFile(join(json.projectPath, 'agentcore/agentcore.json'), 'utf-8'));
      expect(projectSpec.name).toBe(projectName);
      expect(projectSpec.harnesses[0].name).toBe(harnessName);
      expect(projectSpec.harnesses[0].path).toBe(`app/${harnessName}`);
    });

    it('rejects long harness name without --project-name but accepts it with --project-name', async () => {
      const harnessName = `Harness${'A'.repeat(30)}`;
      const rejected = await runCLI(['create', '--name', harnessName, '--skip-install', '--json'], testDir);
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout).success).toBe(false);

      const projectName = `ShortProj${Date.now().toString().slice(-6)}`;
      const accepted = await runCLI(
        ['create', '--project-name', projectName, '--name', harnessName, '--skip-git', '--skip-install', '--json'],
        testDir
      );
      expect(accepted.exitCode, `stdout: ${accepted.stdout}, stderr: ${accepted.stderr}`).toBe(0);
      expect(JSON.parse(accepted.stdout).success).toBe(true);
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
      // --framework triggers agent path where --dry-run is supported
      const result = await runCLI(
        ['create', '--name', name, '--defaults', '--framework', 'Strands', '--dry-run'],
        testDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('would create') || result.stdout.includes('Dry run')).toBeTruthy();
      expect(await exists(join(testDir, name)), 'Should not create directory').toBe(false);
    });

    it('uses project-name for project paths and name for app paths', async () => {
      const projectName = `DryProj${Date.now().toString().slice(-6)}`;
      const agentName = `DryAgent${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'create',
          '--project-name',
          projectName,
          '--name',
          agentName,
          '--defaults',
          '--framework',
          'Strands',
          '--dry-run',
          '--json',
        ],
        testDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.projectPath).toMatch(new RegExp(`/${projectName}$`));
      expect(json.wouldCreate).toContain(`${json.projectPath}/app/${agentName}/`);
      expect(await exists(join(testDir, projectName)), 'Should not create directory').toBe(false);
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
