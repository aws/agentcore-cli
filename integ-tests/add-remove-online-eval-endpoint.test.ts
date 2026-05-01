import {
  type TestProject,
  createTestProject,
  parseJsonOutput,
  readProjectConfig,
  runCLI,
} from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function runSuccess(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

async function runFailure(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode).toBe(1);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', false);
  expect(json).toHaveProperty('error');
  return json as Record<string, unknown>;
}

describe('integration: add and remove online-eval with endpoint', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      name: 'OnlineEvalEP',
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });

    // Add runtime endpoints (prod and staging) for the agent
    await runSuccess(
      ['add', 'runtime-endpoint', '--runtime', project.agentName, '--endpoint', 'prod', '--version', '1', '--json'],
      project.projectPath
    );
    await runSuccess(
      ['add', 'runtime-endpoint', '--runtime', project.agentName, '--endpoint', 'staging', '--version', '1', '--json'],
      project.projectPath
    );

    // Add an evaluator to reference in online eval configs
    await runSuccess(
      [
        'add',
        'evaluator',
        '--name',
        'QualityEval',
        '--level',
        'SESSION',
        '--model',
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        '--instructions',
        'Evaluate quality. Context: {context}',
        '--json',
      ],
      project.projectPath
    );
  }, 120000);

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds online eval with --endpoint prod', async () => {
    const json = await runSuccess(
      [
        'add',
        'online-eval',
        '--name',
        'ProdEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'QualityEval',
        '--sampling-rate',
        '100',
        '--endpoint',
        'prod',
        '--json',
      ],
      project.projectPath
    );

    expect(json.configName).toBe('ProdEval');

    // Verify agentcore.json has endpoint field
    const spec = await readProjectConfig(project.projectPath);
    const evalConfig = spec.onlineEvalConfigs?.find((c: { name: string }) => c.name === 'ProdEval');
    expect(evalConfig).toBeDefined();
    expect(evalConfig!.endpoint).toBe('prod');
    expect(evalConfig!.agent).toBe(project.agentName);
    expect(evalConfig!.evaluators).toContain('QualityEval');
    expect(evalConfig!.samplingRate).toBe(100);
  });

  it('adds online eval with --endpoint staging', async () => {
    const json = await runSuccess(
      [
        'add',
        'online-eval',
        '--name',
        'StagingEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'QualityEval',
        '--sampling-rate',
        '50',
        '--endpoint',
        'staging',
        '--json',
      ],
      project.projectPath
    );

    expect(json.configName).toBe('StagingEval');

    const spec = await readProjectConfig(project.projectPath);
    const evalConfig = spec.onlineEvalConfigs?.find((c: { name: string }) => c.name === 'StagingEval');
    expect(evalConfig).toBeDefined();
    expect(evalConfig!.endpoint).toBe('staging');
  });

  it('adds online eval without --endpoint (no endpoint field in config)', async () => {
    const json = await runSuccess(
      [
        'add',
        'online-eval',
        '--name',
        'NoEndpointEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'QualityEval',
        '--sampling-rate',
        '100',
        '--json',
      ],
      project.projectPath
    );

    expect(json.configName).toBe('NoEndpointEval');

    const spec = await readProjectConfig(project.projectPath);
    const evalConfig = spec.onlineEvalConfigs?.find((c: { name: string }) => c.name === 'NoEndpointEval');
    expect(evalConfig).toBeDefined();
    expect(evalConfig!.endpoint).toBeUndefined();
  });

  it('errors when endpoint does not exist on runtime', async () => {
    const json = await runFailure(
      [
        'add',
        'online-eval',
        '--name',
        'BadEndpointEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'QualityEval',
        '--sampling-rate',
        '100',
        '--endpoint',
        'nonexistent',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toContain('nonexistent');
  });

  it('removes online eval config', async () => {
    const json = await runSuccess(['remove', 'online-eval', '--name', 'ProdEval', '--json'], project.projectPath);
    expect(json.success).toBe(true);

    // Verify removal from agentcore.json
    const spec = await readProjectConfig(project.projectPath);
    const evalConfig = spec.onlineEvalConfigs?.find((c: { name: string }) => c.name === 'ProdEval');
    expect(evalConfig).toBeUndefined();

    // Other eval configs should remain
    const stagingEval = spec.onlineEvalConfigs?.find((c: { name: string }) => c.name === 'StagingEval');
    expect(stagingEval).toBeDefined();
  });

  it('remove returns error for non-existent online eval', async () => {
    const json = await runFailure(['remove', 'online-eval', '--name', 'DoesNotExist', '--json'], project.projectPath);
    expect(json.error).toContain('not found');
  });
});
