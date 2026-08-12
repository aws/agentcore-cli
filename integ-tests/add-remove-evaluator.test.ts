import { createTestProject, parseJsonOutput, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

/** Run a CLI command and assert it succeeds, returning parsed JSON output. */
async function runSuccess(args: string[], cwd: string) {
  const result = await runCLI(args, cwd, { env: telemetry.env });
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

/** Run a CLI command and assert it fails, returning parsed JSON output. */
async function runFailure(args: string[], cwd: string) {
  const result = await runCLI(args, cwd, { env: telemetry.env });
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
    telemetry.destroy();
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
      expect(found!.config.llmAsAJudge?.modelProvider).toBeUndefined();
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
      telemetry.assertMetricEmitted({ command: 'remove.online-eval', exit_reason: 'success' });
    });

    it('removes the evaluator after online eval is gone', async () => {
      await runSuccess(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);

      const config = await readProjectConfig(project.projectPath);
      expect(config.evaluators.find(e => e.name === evalName)).toBeUndefined();
      telemetry.assertMetricEmitted({ command: 'remove.evaluator', exit_reason: 'success' });
    });
  });

  describe('error cases', () => {
    it('adds an OpenResponses evaluator', async () => {
      const name = `OpenResponsesEval${Date.now().toString().slice(-6)}`;
      const json = await runSuccess(
        [
          'add',
          'evaluator',
          '--name',
          name,
          '--level',
          'SESSION',
          '--model-provider',
          'OpenResponses',
          '--model',
          'openai.gpt-5.4',
          '--instructions',
          'Evaluate the session quality. Context: {context}',
          '--json',
        ],
        project.projectPath
      );
      expect(json.evaluatorName).toBe(name);

      const config = await readProjectConfig(project.projectPath);
      expect(config.evaluators.find(e => e.name === name)?.config.llmAsAJudge).toEqual(
        expect.objectContaining({
          modelProvider: 'OpenResponses',
          model: 'openai.gpt-5.4',
        })
      );

      await runSuccess(['remove', 'evaluator', '--name', name, '--json'], project.projectPath);
    });

    it('fails to remove non-existent evaluator', async () => {
      const json = await runFailure(['remove', 'evaluator', '--name', 'NonExistent', '--json'], project.projectPath);
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.evaluator', exit_reason: 'failure' });
    });

    it('fails to remove non-existent online eval config', async () => {
      const json = await runFailure(['remove', 'online-eval', '--name', 'NonExistent', '--json'], project.projectPath);
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.online-eval', exit_reason: 'failure' });
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

    it('rejects the obsolete OpenAI provider discriminator', async () => {
      const json = await runFailure(
        [
          'add',
          'evaluator',
          '--name',
          'ObsoleteProvider',
          '--level',
          'SESSION',
          '--model-provider',
          'OpenAI',
          '--model',
          'openai.gpt-5.4',
          '--instructions',
          'Evaluate {context}',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('Bedrock, OpenResponses');
    });

    it('rejects invalid model IDs before writing config', async () => {
      const json = await runFailure(
        [
          'add',
          'evaluator',
          '--name',
          'InvalidModel',
          '--level',
          'SESSION',
          '--model-provider',
          'OpenResponses',
          '--model',
          '   ',
          '--instructions',
          'Evaluate {context}',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('Model ID is required');
    });

    it('rejects --model-provider when --config is used', async () => {
      const configPath = join(project.projectPath, 'evaluator-config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          llmAsAJudge: {
            model: 'openai.gpt-5.4',
            instructions: 'Evaluate {context}',
            ratingScale: { categorical: [{ label: 'Pass', definition: 'Meets expectations' }] },
          },
        })
      );

      const json = await runFailure(
        [
          'add',
          'evaluator',
          '--name',
          'ConfigProviderConflict',
          '--level',
          'SESSION',
          '--config',
          configPath,
          '--model-provider',
          'OpenResponses',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('--model-provider cannot be used with --config');
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
