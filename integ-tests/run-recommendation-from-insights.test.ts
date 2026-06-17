import { type TestProject, createTestProject, parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

describe('integration: run recommendation --from-insights', () => {
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

  it('accepts --from-insights flag (fails on missing insights job, not flag parsing)', async () => {
    const result = await runCLI(
      ['run', 'recommendation', '--runtime', project.agentName, '--from-insights', 'some-insights-job-id', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    // Should fail because the insights job doesn't exist, not because --from-insights is unrecognized
    expect(json.error).not.toContain('Unknown option');
    expect(json.error).not.toContain('--from-insights');
  });

  it('accepts --batch-evaluation-arn flag (fails on API, not flag parsing)', async () => {
    const result = await runCLI(
      [
        'run',
        'recommendation',
        '--runtime',
        project.agentName,
        '--batch-evaluation-arn',
        'arn:aws:bedrock:us-east-1:123456789012:batch-evaluation/test',
        '--json',
      ],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.error).not.toContain('Unknown option');
    expect(json.error).not.toContain('--batch-evaluation-arn');
  });

  it('--from-insights makes --runtime and --evaluator optional', async () => {
    const result = await runCLI(
      ['run', 'recommendation', '--from-insights', 'some-insights-job-id', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(json.success).toBe(false);
    // Should NOT complain about missing --runtime or --evaluator
    expect(json.error).not.toContain('--runtime');
    expect(json.error).not.toContain('--evaluator');
  });
});
