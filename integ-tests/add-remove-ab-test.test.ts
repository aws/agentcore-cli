import {
  type TestProject,
  createTestProject,
  parseJsonOutput,
  readProjectConfig,
  runCLI,
} from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

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

describe('integration: add and remove ab-test', () => {
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

  it('requires --name for JSON mode', async () => {
    const json = await runFailure(['add', 'ab-test', '--json'], project.projectPath);
    expect(json.error).toContain('--name');
  });

  it('requires --runtime when --name is provided', async () => {
    const json = await runFailure(['add', 'ab-test', '--name', 'Test1', '--json'], project.projectPath);
    expect(json.error).toContain('--runtime');
  });

  it('adds ab-test with all required flags', async () => {
    const json = await runSuccess(
      [
        'add',
        'ab-test',
        '--name',
        'MyIntegTest',
        '--runtime',
        project.agentName,
        '--control-bundle',
        'arn:bundle:control',
        '--control-version',
        'v1',
        '--treatment-bundle',
        'arn:bundle:treatment',
        '--treatment-version',
        'v1',
        '--control-weight',
        '80',
        '--treatment-weight',
        '20',
        '--online-eval',
        'arn:eval:config',
        '--json',
      ],
      project.projectPath
    );

    expect(json.abTestName).toBe('MyIntegTest');

    // Verify it's in agentcore.json with correct structure
    const spec = await readProjectConfig(project.projectPath);
    const abTest = spec.abTests?.find((t: { name: string }) => t.name === 'MyIntegTest');
    expect(abTest).toBeDefined();
    expect(abTest!.variants).toHaveLength(2);
    expect(abTest!.variants[0]!.name).toBe('C');
    expect(abTest!.variants[0]!.weight).toBe(80);
    expect(abTest!.variants[1]!.name).toBe('T1');
    expect(abTest!.variants[1]!.weight).toBe(20);
  });

  it('rejects duplicate AB test name', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--name',
        'MyIntegTest',
        '--runtime',
        project.agentName,
        '--control-bundle',
        'arn:cb',
        '--control-version',
        'v1',
        '--treatment-bundle',
        'arn:tb',
        '--treatment-version',
        'v1',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--online-eval',
        'arn:eval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toContain('already exists');
  });

  it('rejects weights that do not sum to 100', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--name',
        'BadWeights',
        '--runtime',
        project.agentName,
        '--control-bundle',
        'arn:cb',
        '--control-version',
        'v1',
        '--treatment-bundle',
        'arn:tb',
        '--treatment-version',
        'v1',
        '--control-weight',
        '80',
        '--treatment-weight',
        '80',
        '--online-eval',
        'arn:eval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toBeDefined();
  });

  it('removes ab-test', async () => {
    const result = await runCLI(['remove', 'ab-test', '--name', 'MyIntegTest', '--json'], project.projectPath, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const spec = await readProjectConfig(project.projectPath);
    const abTest = spec.abTests?.find((t: { name: string }) => t.name === 'MyIntegTest');
    expect(abTest).toBeUndefined();
    telemetry.assertMetricEmitted({ command: 'remove.ab-test', exit_reason: 'success' });
  });

  it('remove returns error for non-existent test', async () => {
    const result = await runCLI(['remove', 'ab-test', '--name', 'DoesNotExist', '--json'], project.projectPath, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.error).toContain('not found');
    telemetry.assertMetricEmitted({ command: 'remove.ab-test', exit_reason: 'failure' });
  });
});
