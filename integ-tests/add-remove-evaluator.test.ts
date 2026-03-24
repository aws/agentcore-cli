import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

  describe('evaluator lifecycle', () => {
    const evalName = `IntegEval${Date.now().toString().slice(-6)}`;
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const instructions = 'Evaluate the session quality. Context: {context}';

    it('adds an evaluator', async () => {
      const result = await runCLI(
        [
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
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.evaluatorName).toBe(evalName);

      const config = await readProjectConfig(project.projectPath);
      const evaluators = config.evaluators as { name: string; level: string }[];
      const found = evaluators.find(e => e.name === evalName);
      expect(found, `Evaluator "${evalName}" should be in config`).toBeDefined();
      expect(found!.level).toBe('SESSION');
    });

    it('rejects duplicate evaluator name', async () => {
      const result = await runCLI(
        [
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
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('removes the evaluator', async () => {
      const result = await runCLI(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const evaluators = (config.evaluators as { name: string }[]) ?? [];
      expect(evaluators.find(e => e.name === evalName)).toBeUndefined();
    });
  });

  describe('online eval config lifecycle', () => {
    const evalName = `OeEval${Date.now().toString().slice(-6)}`;
    const configName = `OeConfig${Date.now().toString().slice(-6)}`;
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const instructions = 'Evaluate the session quality. Context: {context}';

    it('adds an evaluator as prerequisite', async () => {
      const result = await runCLI(
        [
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
        ],
        project.projectPath
      );
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    });

    it('adds an online eval config', async () => {
      const result = await runCLI(
        [
          'add',
          'online-eval',
          '--name',
          configName,
          '--agent',
          project.agentName,
          '--evaluator',
          evalName,
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.configName).toBe(configName);

      const config = await readProjectConfig(project.projectPath);
      const configs = config.onlineEvalConfigs as {
        name: string;
        agent: string;
        evaluators: string[];
        samplingRate: number;
      }[];
      const found = configs.find(c => c.name === configName);
      expect(found, `Online eval config "${configName}" should be in config`).toBeDefined();
      expect(found!.agent).toBe(project.agentName);
      expect(found!.evaluators).toContain(evalName);
      expect(found!.samplingRate).toBe(50);
    });

    it('rejects duplicate online eval config name', async () => {
      const result = await runCLI(
        [
          'add',
          'online-eval',
          '--name',
          configName,
          '--agent',
          project.agentName,
          '--evaluator',
          evalName,
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('removes the online eval config', async () => {
      const result = await runCLI(['remove', 'online-eval', '--name', configName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const configs = (config.onlineEvalConfigs as { name: string }[]) ?? [];
      expect(configs.find(c => c.name === configName)).toBeUndefined();
    });

    it('cleans up the evaluator', async () => {
      const result = await runCLI(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    });
  });

  describe('evaluator removal blocked by online eval reference', () => {
    const evalName = `BlockEval${Date.now().toString().slice(-6)}`;
    const configName = `BlockCfg${Date.now().toString().slice(-6)}`;
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

    it('sets up evaluator and online eval config', async () => {
      let result = await runCLI(
        [
          'add',
          'evaluator',
          '--name',
          evalName,
          '--level',
          'TRACE',
          '--model',
          model,
          '--instructions',
          'Evaluate trace. Context: {context}. Turn: {assistant_turn}',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode, `evaluator add: ${result.stderr}`).toBe(0);

      result = await runCLI(
        [
          'add',
          'online-eval',
          '--name',
          configName,
          '--agent',
          project.agentName,
          '--evaluator',
          evalName,
          '--sampling-rate',
          '10',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode, `online-eval add: ${result.stderr}`).toBe(0);
    });

    it('rejects evaluator removal while referenced by online eval', async () => {
      const result = await runCLI(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain(configName);
    });

    it('succeeds after removing the online eval config first', async () => {
      let result = await runCLI(['remove', 'online-eval', '--name', configName, '--json'], project.projectPath);
      expect(result.exitCode, `online-eval remove: ${result.stderr}`).toBe(0);

      result = await runCLI(['remove', 'evaluator', '--name', evalName, '--json'], project.projectPath);
      expect(result.exitCode, `evaluator remove: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      const evaluators = (config.evaluators as { name: string }[]) ?? [];
      expect(evaluators.find(e => e.name === evalName)).toBeUndefined();
    });
  });

  describe('error cases', () => {
    it('fails to remove non-existent evaluator', async () => {
      const result = await runCLI(['remove', 'evaluator', '--name', 'NonExistent', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('fails to remove non-existent online eval config', async () => {
      const result = await runCLI(['remove', 'online-eval', '--name', 'NonExistent', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('rejects evaluator with missing --level', async () => {
      const result = await runCLI(['add', 'evaluator', '--name', 'SomeEval', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--level');
    });

    it('rejects evaluator without --model or --config', async () => {
      const result = await runCLI(
        ['add', 'evaluator', '--name', 'SomeEval', '--level', 'SESSION', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--config');
    });

    it('rejects evaluator with instructions missing required placeholders', async () => {
      const result = await runCLI(
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

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('placeholder');
    });

    it('rejects online eval with missing required flags', async () => {
      const result = await runCLI(['add', 'online-eval', '--name', 'SomeConfig', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--agent');
    });

    it('rejects online eval with invalid sampling rate', async () => {
      const result = await runCLI(
        [
          'add',
          'online-eval',
          '--name',
          'SomeConfig',
          '--agent',
          project.agentName,
          '--evaluator',
          'SomeEval',
          '--sampling-rate',
          '200',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('sampling-rate');
    });
  });

  describe('evaluator with different levels and rating scales', () => {
    it('adds a TRACE-level evaluator', async () => {
      const name = `TraceEval${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'evaluator',
          '--name',
          name,
          '--level',
          'TRACE',
          '--model',
          'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          '--instructions',
          'Evaluate trace. Context: {context}. Turn: {assistant_turn}',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const config = await readProjectConfig(project.projectPath);
      const evaluators = config.evaluators as { name: string; level: string }[];
      expect(evaluators.find(e => e.name === name)!.level).toBe('TRACE');

      await runCLI(['remove', 'evaluator', '--name', name, '--json'], project.projectPath);
    });

    it('adds a TOOL_CALL-level evaluator', async () => {
      const name = `ToolEval${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'evaluator',
          '--name',
          name,
          '--level',
          'TOOL_CALL',
          '--model',
          'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          '--instructions',
          'Evaluate tool call. Context: {context}. Tool: {tool_turn}',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const config = await readProjectConfig(project.projectPath);
      const evaluators = config.evaluators as { name: string; level: string }[];
      expect(evaluators.find(e => e.name === name)!.level).toBe('TOOL_CALL');

      await runCLI(['remove', 'evaluator', '--name', name, '--json'], project.projectPath);
    });

    it('adds an evaluator with pass-fail rating scale', async () => {
      const name = `PfEval${Date.now().toString().slice(-6)}`;
      const result = await runCLI(
        [
          'add',
          'evaluator',
          '--name',
          name,
          '--level',
          'SESSION',
          '--model',
          'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          '--instructions',
          'Evaluate session. Context: {context}',
          '--rating-scale',
          'pass-fail',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const config = await readProjectConfig(project.projectPath);
      const evaluators = config.evaluators as {
        name: string;
        config: { llmAsAJudge: { ratingScale: { categorical?: unknown[] } } };
      }[];
      expect(evaluators.find(e => e.name === name)!.config.llmAsAJudge.ratingScale.categorical).toBeDefined();

      await runCLI(['remove', 'evaluator', '--name', name, '--json'], project.projectPath);
    });
  });
});
