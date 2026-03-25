import { readProjectConfig, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: lifecycle configuration', () => {
  let testDir: string;
  let projectPath: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-lifecycle-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runCLI(['create', '--name', 'LifecycleTest', '--no-agent', '--json'], testDir);
    expect(result.exitCode, `setup stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    projectPath = json.projectPath;
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('create with lifecycle flags', () => {
    let createDir: string;

    beforeAll(async () => {
      createDir = join(tmpdir(), `agentcore-integ-lifecycle-create-${randomUUID()}`);
      await mkdir(createDir, { recursive: true });
    });

    afterAll(async () => {
      await rm(createDir, { recursive: true, force: true });
    });

    it('creates project with --idle-timeout and --max-lifetime', async () => {
      const name = `LcCreate${Date.now().toString().slice(-6)}`;
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
          '--idle-timeout',
          '300',
          '--max-lifetime',
          '7200',
          '--json',
        ],
        createDir
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(json.projectPath);
      const agents = config.agents as Record<string, unknown>[];
      expect(agents.length).toBe(1);

      const agent = agents[0]!;
      const lifecycle = agent.lifecycleConfiguration as Record<string, unknown>;
      expect(lifecycle).toBeDefined();
      expect(lifecycle.idleRuntimeSessionTimeout).toBe(300);
      expect(lifecycle.maxLifetime).toBe(7200);
    });

    it('creates project with only --idle-timeout', async () => {
      const name = `LcIdle${Date.now().toString().slice(-6)}`;
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
          '--idle-timeout',
          '600',
          '--json',
        ],
        createDir
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(json.projectPath);
      const agents = config.agents as Record<string, unknown>[];
      const agent = agents[0]!;
      const lifecycle = agent.lifecycleConfiguration as Record<string, unknown>;
      expect(lifecycle).toBeDefined();
      expect(lifecycle.idleRuntimeSessionTimeout).toBe(600);
      expect(lifecycle.maxLifetime).toBeUndefined();
    });

    it('creates project without lifecycle flags — no lifecycleConfiguration in config', async () => {
      const name = `LcNone${Date.now().toString().slice(-6)}`;
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
        createDir
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(json.projectPath);
      const agents = config.agents as Record<string, unknown>[];
      const agent = agents[0]!;
      expect(agent.lifecycleConfiguration).toBeUndefined();
    });
  });

  describe('add agent with lifecycle flags', () => {
    it('adds BYO agent with lifecycle config', async () => {
      const name = `LcByo${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--type',
          'byo',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--code-location',
          `app/${name}/`,
          '--idle-timeout',
          '120',
          '--max-lifetime',
          '3600',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(projectPath);
      const agents = config.agents as Record<string, unknown>[];
      const agent = agents.find(a => a.name === name);
      expect(agent).toBeDefined();
      const lifecycle = agent!.lifecycleConfiguration as Record<string, unknown>;
      expect(lifecycle).toBeDefined();
      expect(lifecycle.idleRuntimeSessionTimeout).toBe(120);
      expect(lifecycle.maxLifetime).toBe(3600);
    });

    it('adds template agent with only --max-lifetime', async () => {
      const name = `LcTmpl${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--language',
          'Python',
          '--max-lifetime',
          '14400',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(projectPath);
      const agents = config.agents as Record<string, unknown>[];
      const agent = agents.find(a => a.name === name);
      expect(agent).toBeDefined();
      const lifecycle = agent!.lifecycleConfiguration as Record<string, unknown>;
      expect(lifecycle).toBeDefined();
      expect(lifecycle.idleRuntimeSessionTimeout).toBeUndefined();
      expect(lifecycle.maxLifetime).toBe(14400);
    });
  });

  describe('validation rejects invalid lifecycle values', () => {
    it('rejects idle-timeout below 60', async () => {
      const name = `LcLow${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--type',
          'byo',
          '--language',
          'Python',
          '--code-location',
          `app/${name}/`,
          '--idle-timeout',
          '30',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode).not.toBe(0);
    });

    it('rejects max-lifetime above 28800', async () => {
      const name = `LcHigh${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--type',
          'byo',
          '--language',
          'Python',
          '--code-location',
          `app/${name}/`,
          '--max-lifetime',
          '99999',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode).not.toBe(0);
    });

    it('rejects idle-timeout > max-lifetime', async () => {
      const name = `LcCross${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--type',
          'byo',
          '--language',
          'Python',
          '--code-location',
          `app/${name}/`,
          '--idle-timeout',
          '5000',
          '--max-lifetime',
          '3000',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode).not.toBe(0);
    });

    it('rejects non-integer idle-timeout', async () => {
      const name = `LcFloat${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          name,
          '--type',
          'byo',
          '--language',
          'Python',
          '--code-location',
          `app/${name}/`,
          '--idle-timeout',
          '120.5',
          '--json',
        ],
        projectPath
      );

      expect(result.exitCode).not.toBe(0);
    });
  });
});
