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

describe('integration: add and remove target-based ab-test', () => {
  let project: TestProject;
  const gatewayName = 'my-test-gw';

  beforeAll(async () => {
    project = await createTestProject({
      name: 'TargetABTest',
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

    // Add an evaluator and two online eval configs (one per variant)
    await runSuccess(
      [
        'add',
        'evaluator',
        '--name',
        'TestEval',
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
    await runSuccess(
      [
        'add',
        'online-eval',
        '--name',
        'ControlEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'TestEval',
        '--sampling-rate',
        '100',
        '--endpoint',
        'prod',
        '--json',
      ],
      project.projectPath
    );
    await runSuccess(
      [
        'add',
        'online-eval',
        '--name',
        'TreatmentEval',
        '--runtime',
        project.agentName,
        '--evaluator',
        'TestEval',
        '--sampling-rate',
        '100',
        '--endpoint',
        'staging',
        '--json',
      ],
      project.projectPath
    );
  }, 120000);

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds target-based AB test with --control-endpoint and --treatment-endpoint', async () => {
    const json = await runSuccess(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'TargetTest1',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '90',
        '--treatment-weight',
        '10',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.abTestName).toBe('TargetTest1');

    // Verify agentcore.json has correct mode, targets, gateway auto-created
    const spec = await readProjectConfig(project.projectPath);
    const abTest = spec.abTests?.find((t: { name: string }) => t.name === 'TargetTest1');
    expect(abTest).toBeDefined();
    expect(abTest!.mode).toBe('target-based');
    expect(abTest!.variants).toHaveLength(2);
    expect(abTest!.variants[0]!.name).toBe('C');
    expect(abTest!.variants[0]!.weight).toBe(90);
    expect(abTest!.variants[0]!.variantConfiguration.target).toBeDefined();
    expect(abTest!.variants[0]!.variantConfiguration.target!.targetName).toBe(`${project.agentName}-prod`);
    expect(abTest!.variants[1]!.name).toBe('T1');
    expect(abTest!.variants[1]!.weight).toBe(10);
    expect(abTest!.variants[1]!.variantConfiguration.target!.targetName).toBe(`${project.agentName}-staging`);
    expect(abTest!.gatewayRef).toBe(`{{gateway:${gatewayName}}}`);

    // Verify gateway was auto-created with targets
    const gw = spec.httpGateways?.find((g: { name: string }) => g.name === gatewayName);
    expect(gw, 'HTTP gateway should have been auto-created').toBeDefined();
    expect(gw!.targets).toBeDefined();
    expect(gw!.targets!.length).toBeGreaterThanOrEqual(2);

    const controlTarget = gw!.targets!.find((t: { name: string }) => t.name === `${project.agentName}-prod`);
    expect(controlTarget).toBeDefined();
    expect(controlTarget!.qualifier).toBe('prod');

    const treatmentTarget = gw!.targets!.find((t: { name: string }) => t.name === `${project.agentName}-staging`);
    expect(treatmentTarget).toBeDefined();
    expect(treatmentTarget!.qualifier).toBe('staging');

    // Verify per-variant evaluation config
    const evalConfig = abTest!.evaluationConfig;
    expect('perVariantOnlineEvaluationConfig' in evalConfig).toBe(true);
    if ('perVariantOnlineEvaluationConfig' in evalConfig) {
      expect(evalConfig.perVariantOnlineEvaluationConfig).toHaveLength(2);
      const controlEval = evalConfig.perVariantOnlineEvaluationConfig.find(
        (p: { treatmentName: string }) => p.treatmentName === 'C'
      );
      expect(controlEval?.onlineEvaluationConfigArn).toBe('ControlEval');
      const treatmentEval = evalConfig.perVariantOnlineEvaluationConfig.find(
        (p: { treatmentName: string }) => p.treatmentName === 'T1'
      );
      expect(treatmentEval?.onlineEvaluationConfigArn).toBe('TreatmentEval');
    }
  });

  it('adds target-based AB test with existing gateway', async () => {
    // TargetTest1 already created the gateway — reuse it
    const json = await runSuccess(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'TargetTest2',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.abTestName).toBe('TargetTest2');

    const spec = await readProjectConfig(project.projectPath);
    // Gateway should still exist (reused, not duplicated)
    const gateways = spec.httpGateways?.filter((g: { name: string }) => g.name === gatewayName);
    expect(gateways).toHaveLength(1);
  });

  it('rejects duplicate AB test name', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'TargetTest1',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
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
        '--mode',
        'target-based',
        '--name',
        'BadWeights',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '80',
        '--treatment-weight',
        '80',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toBeDefined();
  });

  it('errors when --control-endpoint is missing in target-based mode', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'MissingControl',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toContain('--control-endpoint');
  });

  it('errors when --runtime is missing in target-based mode', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'MissingRuntime',
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'prod',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toContain('--runtime');
  });

  it('errors when endpoint does not exist on runtime', async () => {
    const json = await runFailure(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'BadEndpoint',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-endpoint',
        'nonexistent',
        '--treatment-endpoint',
        'staging',
        '--control-weight',
        '50',
        '--treatment-weight',
        '50',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.error).toContain('nonexistent');
  });

  it('deprecated --control-qualifier still works as alias for --control-endpoint', async () => {
    const json = await runSuccess(
      [
        'add',
        'ab-test',
        '--mode',
        'target-based',
        '--name',
        'QualifierAlias',
        '--runtime',
        project.agentName,
        '--gateway',
        gatewayName,
        '--control-qualifier',
        'prod',
        '--treatment-qualifier',
        'staging',
        '--control-weight',
        '60',
        '--treatment-weight',
        '40',
        '--control-online-eval',
        'ControlEval',
        '--treatment-online-eval',
        'TreatmentEval',
        '--json',
      ],
      project.projectPath
    );

    expect(json.abTestName).toBe('QualifierAlias');

    const spec = await readProjectConfig(project.projectPath);
    const abTest = spec.abTests?.find((t: { name: string }) => t.name === 'QualifierAlias');
    expect(abTest).toBeDefined();
    expect(abTest!.mode).toBe('target-based');
    expect(abTest!.variants[0]!.variantConfiguration.target!.targetName).toBe(`${project.agentName}-prod`);
    expect(abTest!.variants[1]!.variantConfiguration.target!.targetName).toBe(`${project.agentName}-staging`);
  });

  it('removes target-based AB test without --delete-gateway', async () => {
    const json = await runSuccess(['remove', 'ab-test', '--name', 'TargetTest2', '--json'], project.projectPath);
    expect(json.success).toBe(true);

    // Verify removal from agentcore.json
    const spec = await readProjectConfig(project.projectPath);
    const abTest = spec.abTests?.find((t: { name: string }) => t.name === 'TargetTest2');
    expect(abTest).toBeUndefined();

    // Gateway should still exist (other AB tests reference it)
    const gw = spec.httpGateways?.find((g: { name: string }) => g.name === gatewayName);
    expect(gw, 'Gateway should still exist when other AB tests reference it').toBeDefined();
  });

  it('removes target-based AB test with --delete-gateway flag', async () => {
    // First remove QualifierAlias so only TargetTest1 is left referencing the gateway
    await runSuccess(['remove', 'ab-test', '--name', 'QualifierAlias', '--json'], project.projectPath);

    // Now remove TargetTest1 with --delete-gateway
    const json = await runSuccess(
      ['remove', 'ab-test', '--name', 'TargetTest1', '--delete-gateway', '--json'],
      project.projectPath
    );
    expect(json.success).toBe(true);

    // Verify gateway was also removed (no other AB tests reference it)
    const spec = await readProjectConfig(project.projectPath);
    const gw = spec.httpGateways?.find((g: { name: string }) => g.name === gatewayName);
    expect(gw, 'Gateway should be removed with --delete-gateway when no other AB tests reference it').toBeUndefined();
  });

  it('remove returns error for non-existent test', async () => {
    const json = await runFailure(['remove', 'ab-test', '--name', 'DoesNotExist', '--json'], project.projectPath);
    expect(json.error).toContain('not found');
  });
});
