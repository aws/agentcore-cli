import {
  type TestProject,
  createTestProject,
  parseJsonOutput,
  readProjectConfig,
  runCLI,
  runFailure,
  runSuccess,
} from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

describe('integration: add and remove config-bundle', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
    telemetry.destroy();
  });

  // ── Add lifecycle ─────────────────────────────────────────────────────

  describe('add config-bundle', () => {
    it('adds a config bundle with inline --components', async () => {
      const components = JSON.stringify({
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc': {
          configuration: { systemPrompt: 'You are a helpful assistant.' },
        },
      });

      const json = await runSuccess(
        ['add', 'config-bundle', '--name', 'InlineBundle', '--components', components, '--json'],
        project.projectPath
      );

      expect(json.bundleName).toBe('InlineBundle');

      const config = await readProjectConfig(project.projectPath);
      const bundle = config.configBundles.find(b => b.name === 'InlineBundle');
      expect(bundle).toBeDefined();
      expect(bundle!.type).toBe('ConfigurationBundle');
      expect(bundle!.branchName).toBe('mainline');
      expect(Object.keys(bundle!.components)).toHaveLength(1);
    });

    it('adds a config bundle with --components-file', async () => {
      const componentsData = {
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-def': {
          configuration: { temperature: 0.7, maxTokens: 1024 },
        },
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-xyz': {
          configuration: { rateLimit: 100 },
        },
      };

      const filePath = join(project.projectPath, 'test-components.json');
      await writeFile(filePath, JSON.stringify(componentsData));

      const json = await runSuccess(
        ['add', 'config-bundle', '--name', 'FileBundle', '--components-file', filePath, '--json'],
        project.projectPath
      );

      expect(json.bundleName).toBe('FileBundle');

      const config = await readProjectConfig(project.projectPath);
      const bundle = config.configBundles.find(b => b.name === 'FileBundle');
      expect(bundle).toBeDefined();
      expect(Object.keys(bundle!.components)).toHaveLength(2);
    });

    it('adds a config bundle with optional description, branch, and commit message', async () => {
      const components = JSON.stringify({
        '{{runtime:MyAgent}}': {
          configuration: { systemPrompt: 'Placeholder-based bundle' },
        },
      });

      const json = await runSuccess(
        [
          'add',
          'config-bundle',
          '--name',
          'FullOptsBundle',
          '--description',
          'A bundle with all optional fields',
          '--components',
          components,
          '--branch',
          'feature-branch',
          '--commit-message',
          'initial config',
          '--json',
        ],
        project.projectPath
      );

      expect(json.bundleName).toBe('FullOptsBundle');

      const config = await readProjectConfig(project.projectPath);
      const bundle = config.configBundles.find(b => b.name === 'FullOptsBundle');
      expect(bundle).toBeDefined();
      expect(bundle!.description).toBe('A bundle with all optional fields');
      expect(bundle!.branchName).toBe('feature-branch');
      expect(bundle!.commitMessage).toBe('initial config');
    });

    it('adds a config bundle with placeholder component keys', async () => {
      const components = JSON.stringify({
        '{{runtime:AgentA}}': {
          configuration: { systemPrompt: 'Runtime placeholder' },
        },
        '{{gateway:GatewayB}}': {
          configuration: { rateLimitPerSecond: 50 },
        },
      });

      const json = await runSuccess(
        ['add', 'config-bundle', '--name', 'PlaceholderBundle', '--components', components, '--json'],
        project.projectPath
      );

      expect(json.bundleName).toBe('PlaceholderBundle');

      const config = await readProjectConfig(project.projectPath);
      const bundle = config.configBundles.find(b => b.name === 'PlaceholderBundle');
      expect(bundle).toBeDefined();
      const keys = Object.keys(bundle!.components);
      expect(keys).toContain('{{runtime:AgentA}}');
      expect(keys).toContain('{{gateway:GatewayB}}');
    });
  });

  // ── Validation / error cases ──────────────────────────────────────────

  describe('validation errors', () => {
    it('rejects duplicate config bundle name', async () => {
      const components = JSON.stringify({
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-dup': {
          configuration: { foo: 'bar' },
        },
      });

      const json = await runFailure(
        ['add', 'config-bundle', '--name', 'InlineBundle', '--components', components, '--json'],
        project.projectPath
      );

      expect(json.error).toContain('already exists');
    });

    it('requires --name in non-interactive (JSON) mode', async () => {
      const result = await runCLI(
        ['add', 'config-bundle', '--components', '{"arn:test": {"configuration": {}}}', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--name');
    });

    it('requires --components or --components-file when --name is provided', async () => {
      const json = await runFailure(['add', 'config-bundle', '--name', 'NoComponents', '--json'], project.projectPath);

      expect(json.error).toContain('--components');
    });

    it('rejects invalid JSON in --components', async () => {
      const result = await runCLI(
        ['add', 'config-bundle', '--name', 'BadJson', '--components', '{not valid json}', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });

    it('rejects --components-file with non-existent file', async () => {
      const result = await runCLI(
        [
          'add',
          'config-bundle',
          '--name',
          'MissingFile',
          '--components-file',
          '/tmp/does-not-exist-xyz.json',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });

    it('rejects bundle name with invalid characters', async () => {
      const components = JSON.stringify({
        'arn:test': { configuration: {} },
      });

      const json = await runFailure(
        ['add', 'config-bundle', '--name', 'invalid-name!', '--components', components, '--json'],
        project.projectPath
      );

      expect(json.error).toBeDefined();
    });

    it('rejects bundle name starting with a number', async () => {
      const components = JSON.stringify({
        'arn:test': { configuration: {} },
      });

      const json = await runFailure(
        ['add', 'config-bundle', '--name', '1BadName', '--components', components, '--json'],
        project.projectPath
      );

      expect(json.error).toBeDefined();
    });
  });

  // ── Remove lifecycle ──────────────────────────────────────────────────

  describe('remove config-bundle', () => {
    it('removes an existing config bundle', async () => {
      const result = await runCLI(
        ['remove', 'config-bundle', '--name', 'InlineBundle', '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const bundle = config.configBundles.find(b => b.name === 'InlineBundle');
      expect(bundle).toBeUndefined();
      telemetry.assertMetricEmitted({ command: 'remove.config-bundle', exit_reason: 'success' });
    });

    it('returns error for non-existent bundle', async () => {
      const result = await runCLI(
        ['remove', 'config-bundle', '--name', 'DoesNotExist', '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.config-bundle', exit_reason: 'failure' });
    });

    it('removes all remaining config bundles one by one', async () => {
      const configBefore = await readProjectConfig(project.projectPath);
      const remaining = configBefore.configBundles.map(b => b.name);

      for (const name of remaining) {
        await runSuccess(['remove', 'config-bundle', '--name', name, '--json'], project.projectPath);
      }

      const configAfter = await readProjectConfig(project.projectPath);
      expect(configAfter.configBundles).toHaveLength(0);
    });
  });

  // ── Multiple bundles coexistence ──────────────────────────────────────

  describe('multiple bundles coexistence', () => {
    const bundleNames = ['BundleAlpha', 'BundleBeta', 'BundleGamma'];

    it('can add multiple config bundles to the same project', async () => {
      for (const name of bundleNames) {
        const components = JSON.stringify({
          [`arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`]: {
            configuration: { bundleId: name },
          },
        });

        await runSuccess(
          ['add', 'config-bundle', '--name', name, '--components', components, '--json'],
          project.projectPath
        );
      }

      const config = await readProjectConfig(project.projectPath);
      expect(config.configBundles).toHaveLength(bundleNames.length);

      for (const name of bundleNames) {
        expect(config.configBundles.find(b => b.name === name)).toBeDefined();
      }
    });

    it('removing one bundle does not affect others', async () => {
      await runSuccess(['remove', 'config-bundle', '--name', 'BundleBeta', '--json'], project.projectPath);

      const config = await readProjectConfig(project.projectPath);
      expect(config.configBundles).toHaveLength(2);
      expect(config.configBundles.find(b => b.name === 'BundleAlpha')).toBeDefined();
      expect(config.configBundles.find(b => b.name === 'BundleGamma')).toBeDefined();
      expect(config.configBundles.find(b => b.name === 'BundleBeta')).toBeUndefined();
    });

    afterAll(async () => {
      for (const name of bundleNames) {
        try {
          await runCLI(['remove', 'config-bundle', '--name', name, '--json'], project.projectPath);
        } catch {
          // already removed
        }
      }
    });
  });
});
