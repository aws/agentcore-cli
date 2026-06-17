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
  const result = await runCLI(args, cwd, { env: telemetry.env });
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

async function runFailure(args: string[], cwd: string) {
  const result = await runCLI(args, cwd, { env: telemetry.env });
  expect(result.exitCode).toBe(1);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', false);
  expect(json).toHaveProperty('error');
  return json as Record<string, unknown>;
}

describe('integration: add and remove online-insights configs', () => {
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

  describe('online-insights lifecycle', () => {
    const configName = `IntegInsights${Date.now().toString().slice(-6)}`;
    const insightId = 'Builtin.Insight.FailureAnalysis';

    it('adds an online-insights config', async () => {
      const json = await runSuccess(
        [
          'add',
          'online-insights',
          '--name',
          configName,
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );
      expect(json.configName).toBe(configName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find((c: { name: string }) => c.name === configName);
      expect(found).toBeDefined();
      expect(found!.agent).toBe(project.agentName);
      expect(found!.insights).toContain(insightId);
      expect(found!.samplingRate).toBe(50);
      expect(found!.evaluators).toBeUndefined();
    });

    it('rejects duplicate online-insights config name', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          configName,
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('already exists');
    });

    it('adds online-insights with clustering frequencies', async () => {
      const clusterName = `ClusterInsights${Date.now().toString().slice(-6)}`;
      const json = await runSuccess(
        [
          'add',
          'online-insights',
          '--name',
          clusterName,
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '100',
          '--clustering-frequency',
          'DAILY',
          'WEEKLY',
          '--json',
        ],
        project.projectPath
      );
      expect(json.configName).toBe(clusterName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find((c: { name: string }) => c.name === clusterName);
      expect(found).toBeDefined();
      expect(found!.clusteringConfig).toBeDefined();
      expect(found!.clusteringConfig!.frequencies).toContain('DAILY');
      expect(found!.clusteringConfig!.frequencies).toContain('WEEKLY');
    });

    it('adds online-insights with --enable-on-create', async () => {
      const enabledName = `EnabledInsights${Date.now().toString().slice(-6)}`;
      const json = await runSuccess(
        [
          'add',
          'online-insights',
          '--name',
          enabledName,
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '75',
          '--enable-on-create',
          '--json',
        ],
        project.projectPath
      );
      expect(json.configName).toBe(enabledName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find((c: { name: string }) => c.name === enabledName);
      expect(found).toBeDefined();
      expect(found!.enableOnCreate).toBe(true);
    });

    it('adds online-insights with endpoint', async () => {
      // First add an endpoint to the runtime
      await runSuccess(
        ['add', 'runtime-endpoint', '--runtime', project.agentName, '--endpoint', 'prod', '--version', '1', '--json'],
        project.projectPath
      );

      const epName = `EPInsights${Date.now().toString().slice(-6)}`;
      const json = await runSuccess(
        [
          'add',
          'online-insights',
          '--name',
          epName,
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '50',
          '--endpoint',
          'prod',
          '--json',
        ],
        project.projectPath
      );
      expect(json.configName).toBe(epName);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find((c: { name: string }) => c.name === epName);
      expect(found).toBeDefined();
      expect(found!.endpoint).toBe('prod');
    });

    it('rejects online-insights with non-existent endpoint', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'BadEP',
          '--runtime',
          project.agentName,
          '--insights',
          insightId,
          '--sampling-rate',
          '50',
          '--endpoint',
          'nonexistent',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('nonexistent');
    });

    it('removes the online-insights config', async () => {
      await runSuccess(['remove', 'online-insights', '--name', configName, '--json'], project.projectPath);

      const config = await readProjectConfig(project.projectPath);
      const found = config.onlineEvalConfigs.find(
        (c: { name: string; insights?: string[] }) => c.name === configName && c.insights?.length
      );
      expect(found).toBeUndefined();
      telemetry.assertMetricEmitted({ command: 'remove.online-insights', exit_reason: 'success' });
    });
  });

  describe('error cases', () => {
    it('rejects online-insights with missing --runtime', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'SomeConfig',
          '--insights',
          'Builtin.Insight.FailureAnalysis',
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('--runtime');
    });

    it('rejects online-insights with missing --insights', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'SomeConfig',
          '--runtime',
          project.agentName,
          '--sampling-rate',
          '50',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('--insights');
    });

    it('rejects online-insights with missing --sampling-rate', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'SomeConfig',
          '--runtime',
          project.agentName,
          '--insights',
          'Builtin.Insight.FailureAnalysis',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('--sampling-rate');
    });

    it('rejects online-insights with invalid sampling rate (too high)', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'SomeConfig',
          '--runtime',
          project.agentName,
          '--insights',
          'Builtin.Insight.FailureAnalysis',
          '--sampling-rate',
          '200',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('sampling-rate');
    });

    it('rejects online-insights with invalid sampling rate (too low)', async () => {
      const json = await runFailure(
        [
          'add',
          'online-insights',
          '--name',
          'SomeConfig',
          '--runtime',
          project.agentName,
          '--insights',
          'Builtin.Insight.FailureAnalysis',
          '--sampling-rate',
          '0',
          '--json',
        ],
        project.projectPath
      );
      expect(json.error).toContain('sampling-rate');
    });

    it('fails to remove non-existent online-insights config', async () => {
      const json = await runFailure(
        ['remove', 'online-insights', '--name', 'NonExistent', '--json'],
        project.projectPath
      );
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.online-insights', exit_reason: 'failure' });
    });
  });
});
