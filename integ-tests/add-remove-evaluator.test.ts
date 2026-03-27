import { createTestProject, parseJsonOutput, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Run a CLI command and assert it succeeds, returning parsed JSON output. */
async function runSuccess(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

/** Run a CLI command and assert it fails, returning parsed JSON output. */
async function runFailure(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode).toBe(1);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', false);
  expect(json).toHaveProperty('error');
  return json as Record<string, unknown>;
}

describe('integration: add and remove evaluators and online eval configs', () => {
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

  describe('evaluator and online eval lifecycle', () => {
    const evalName = `IntegEval${Date.now().toString().slice(-6)}`;
    const configName = `IntegCfg${Date.now().toString().slice(-6)}`;
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const instructions = 'Evaluate the session quality. Context: {context}';
    const addEvalArgs = [
      'add',
      'evaluator',
      '--name',
      evalName,
      '--level',
      'SESSION',
      '--model',
      model,
      '--instructions',
      instructions,
      '--json',
    ];
    it('adds an evaluator', async () => {
      const json = await runSuccess(addEvalArgs, project.projectPath);
      expect(json.evaluatorName).toBe(evalName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.evaluators.find(e => e.name === evalName);
      expect(found).toBeDefined();
      expect(found!.level).toBe('SESSION');
    });

    it('rejects duplicate evaluator name', async () => {
      const json = await runFailure(addEvalArgs, project.projectPath);
      expect(json.error).toContain('already exists');
    });

    it('adds an online eval config referencing the evaluator', async () => {
      const args = [
        'add',
        'online-eval',
        '--name',
        configName,
        '--runtime',
        project.agentName,
        '--evaluator',
        evalName,
        '--sampling-rate',
        '50',
        '--json',
      ];
      const json = await runSuccess(args, project.projectPath);
      expect(json.configName).toBe(configName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find(c => c.name === configName);
      expect(found).toBeDefined();
      expect(found!.agent).toBe(project.agentName);
      expect(found!.evaluators).toContain(evalName);
      expect(found!.samplingRate).toBe(50);
    });

    it('rejects duplicate online eval config name', async () => {
      const args = [
        'add',
        'online-eval',
        '--name',
        configName,
        '--runtime',
        project.agentName,
        '--evaluator',
        evalName,
        '--sampling-rate',
        '50',
        '--json',
      ];
      const json = await runFailure(args, project.projectPath);
      expect(json.error).toContain('already exists');
    });

    it('rejects evaluator removal while referenced by online eval', async () => {
      const json = await runFailure(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);
      expect(json.error).toContain(configName);
    });

    it('removes the online eval config', async () => {
      await runSuccess(['remove', 'online-eval', '--name', configName, '--json'], project.projectPath);

      const config = await readProjectConfig(project.projectPath);
      expect(config.onlineEvalConfigs.find(c => c.name === configName)).toBeUndefined();
    });

    it('removes the evaluator after online eval is gone', async () => {
      await runSuccess(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);

      const config = await readProjectConfig(project.projectPath);
      expect(config.evaluators.find(e => e.name === evalName)).toBeUndefined();
    });
  });

  describe('error cases', () => {
    it('fails to remove non-existent evaluator', async () => {
      const json = await runFailure(['remove', 'evaluator', '--name', 'NonExistent', '--json'], project.projectPath);
      expect(json.error).toContain('not found');
    });

    it('fails to remove non-existent online eval config', async () => {
      const json = await runFailure(['remove', 'online-eval', '--name', 'NonExistent', '--json'], project.projectPath);
      expect(json.error).toContain('not found');
    });

    it('rejects evaluator with missing --level', async () => {
      const json = await runFailure(['add', 'evaluator', '--name', 'SomeEval', '--json'], project.projectPath);
      expect(json.error).toContain('--level');
    });

    it('rejects evaluator without --model or --config', async () => {
      const json = await runFailure(
        ['add', 'evaluator', '--name', 'SomeEval', '--level', 'SESSION', '--json'],
        project.projectPath
      );
      expect(json.error).toContain('--config');
    });

    it('rejects evaluator with instructions missing required placeholders', async () => {
      const json = await runFailure(
        [
          'add',
          'evaluator',
          '--name',
          'SomeEval',
          '--level',
          'SESSION',
          '--model',
          'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          '--instructions',
          'No placeholders here',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('placeholder');
    });

    it('rejects online eval with missing required flags', async () => {
      const json = await runFailure(['add', 'online-eval', '--name', 'SomeConfig', '--json'], project.projectPath);
      expect(json.error).toContain('--runtime');
    });

    it('rejects online eval with invalid sampling rate', async () => {
      const json = await runFailure(
        [
          'add',
          'online-eval',
          '--name',
          'SomeConfig',
          '--runtime',
          project.agentName,
          '--evaluator',
          'SomeEval',
          '--sampling-rate',
          '200',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('sampling-rate');
    });
  });
});
