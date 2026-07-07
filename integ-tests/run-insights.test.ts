import { type TestProject, createTestProject, parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: run insights command validation', () => {
  let project: TestProject;
  const telemetry = createTelemetryHelper();

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

  it('fails when agent is not deployed (no deployed state)', async () => {
    const result = await runCLI(['run', 'insights', '--runtime', project.agentName, '--json'], project.projectPath, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toBeTruthy();
  });

  it('fails with --name that violates naming constraints', async () => {
    const result = await runCLI(
      ['run', 'insights', '--runtime', project.agentName, '--name', '123-invalid-start', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toBeTruthy();
  });

  it('accepts --insights flag with custom insight IDs', async () => {
    const result = await runCLI(
      ['run', 'insights', '--runtime', project.agentName, '--insights', 'Builtin.Insight.FailureAnalysis', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.error).not.toContain('--insights');
  });

  it('accepts --evaluator flag for recommendation chaining', async () => {
    const result = await runCLI(
      ['run', 'insights', '--runtime', project.agentName, '--evaluator', 'Builtin.Accuracy', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.error).not.toContain('--evaluator');
  });

  it('accepts --lookback-days flag', async () => {
    const result = await runCLI(
      ['run', 'insights', '--runtime', project.agentName, '--lookback-days', '14', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.error).not.toContain('--lookback-days');
  });

  it('accepts --session-ids flag', async () => {
    const result = await runCLI(
      ['run', 'insights', '--runtime', project.agentName, '--session-ids', 'sess-001', 'sess-002', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.error).not.toContain('--session-ids');
  });

  it('accepts --online-eval-config-arn as data source (no --runtime needed)', async () => {
    const result = await runCLI(
      [
        'run',
        'insights',
        '--online-eval-config-arn',
        'arn:aws:bedrock:us-east-1:123456789012:online-evaluation-config/test',
        '--json',
      ],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.error).not.toContain('--runtime');
    expect(json.error).not.toContain('required');
  });
});

describe('integration: view insights command', () => {
  let project: TestProject;
  const telemetry = createTelemetryHelper();

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

  it('returns empty list when no insights jobs exist', async () => {
    const result = await runCLI(['view', 'insights', '--json'], project.projectPath, { env: telemetry.env });
    expect(result.exitCode).toBe(0);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect(json.insights).toEqual([]);
  });

  it('returns not-found for a non-existent insights job ID', async () => {
    const result = await runCLI(['view', 'insights', 'nonexistent-id', '--json'], project.projectPath, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toContain('not found');
  });
});

describe('integration: pause/resume online-insights validation', () => {
  let project: TestProject;
  const telemetry = createTelemetryHelper();

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

  it('pause online-insights fails without name or --arn', async () => {
    const result = await runCLI(['pause', 'online-insights', '--json'], project.projectPath, { env: telemetry.env });
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toContain('name or --arn');
  });

  it('resume online-insights fails without name or --arn', async () => {
    const result = await runCLI(['resume', 'online-insights', '--json'], project.projectPath, { env: telemetry.env });
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toContain('name or --arn');
  });
});

describe('integration: archive insights validation', () => {
  let project: TestProject;
  const telemetry = createTelemetryHelper();

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

  it('archive insights fails for non-existent ID', async () => {
    const result = await runCLI(['archive', 'insights', '--id', 'nonexistent-job-id', '--json'], project.projectPath, {
      env: telemetry.env,
    });
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).toContain('not found');
  });
});
