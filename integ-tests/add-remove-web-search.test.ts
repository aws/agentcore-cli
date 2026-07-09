import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

interface ConfigurationEntry {
  name: string;
  description?: string;
  parameterValues?: Record<string, unknown>;
  parameterOverrides?: { path: string; description?: string; visible?: boolean }[];
}

interface ConnectorTarget {
  name: string;
  targetType: string;
  connectorId?: string;
  configurations?: ConfigurationEntry[];
}

interface Gateway {
  name: string;
  targets?: ConnectorTarget[];
}

async function readProjectConfig(projectPath: string) {
  return JSON.parse(await readFile(join(projectPath, 'agentcore/agentcore.json'), 'utf-8'));
}

async function findTarget(
  projectPath: string,
  gatewayName: string,
  targetName: string
): Promise<ConnectorTarget | undefined> {
  const config = await readProjectConfig(projectPath);
  const gateway = (config.agentCoreGateways as Gateway[]).find(g => g.name === gatewayName);
  return gateway?.targets?.find(t => t.name === targetName);
}

describe('integration: add and remove web-search via --connector flag', () => {
  let project: TestProject;
  const gatewayName = 'WsGateway';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
    const result = await runCLI(
      ['add', 'gateway', '--name', gatewayName, '--protocol-type', 'MCP', '--json'],
      project.projectPath
    );
    expect(result.exitCode).toBe(0);
  });

  afterAll(async () => {
    await project.cleanup();
    telemetry.destroy();
  });

  it('adds a web-search connector target with no excludeDomains', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-plain',
        '--json',
      ],
      project.projectPath,
      { env: telemetry.env }
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const target = await findTarget(project.projectPath, gatewayName, 'ws-plain');
    expect(target).toBeTruthy();
    expect(target?.targetType).toBe('connector');
    expect(target?.connectorId).toBe('web-search');
    expect(target?.configurations).toHaveLength(1);
    expect(target?.configurations?.[0]?.name).toBe('WebSearch');
    expect(target?.configurations?.[0]?.description).toBe('');
    expect(target?.configurations?.[0]?.parameterValues).toEqual({});
    expect(target?.configurations?.[0]?.parameterOverrides).toEqual([]);
    telemetry.assertMetricEmitted({ command: 'add.gateway-target', exit_reason: 'success' });
  });

  it('adds a web-search connector target with --exclude-domains', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-filtered',
        '--exclude-domains',
        'foo.com,bar.net',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const target = await findTarget(project.projectPath, gatewayName, 'ws-filtered');
    const pv = target!.configurations![0]!.parameterValues!;
    expect((pv?.domainFilter as { exclude: string[] })?.exclude).toEqual(['foo.com', 'bar.net']);
  });

  it('trims whitespace in --exclude-domains values', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-trimmed',
        '--exclude-domains',
        'a.com, b.com,  c.com',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'ws-trimmed');
    const pv = target!.configurations![0]!.parameterValues!;
    expect((pv?.domainFilter as { exclude: string[] })?.exclude).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('rejects repeated --exclude-domains', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-repeat',
        '--exclude-domains',
        'foo.com',
        '--exclude-domains',
        'bar.net',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--exclude-domains may only be specified once');
    const target = await findTarget(project.projectPath, gatewayName, 'ws-repeat');
    expect(target).toBeUndefined();
  });

  it('rejects --exclude-domains on non-web-search connector', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'bedrock-knowledge-bases',
        '--gateway',
        gatewayName,
        '--name',
        'x',
        '--knowledge-base-id',
        'ABCDEFGHIJ',
        '--exclude-domains',
        'foo.com',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--exclude-domains only applies to --connector web-search');
  });

  it('rejects --type web-search (old path removed)', async () => {
    const result = await runCLI(
      ['add', 'gateway-target', '--type', 'web-search', '--gateway', gatewayName, '--name', 'ws-old', '--json'],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Invalid type');
  });

  it('removes a web-search target via remove gateway-target', async () => {
    const result = await runCLI(
      ['remove', 'gateway-target', '--name', 'ws-plain', '--yes', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );

    expect(result.exitCode).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'ws-plain');
    expect(target).toBeUndefined();
    telemetry.assertMetricEmitted({ command: 'remove.gateway-target', exit_reason: 'success' });
  });

  it('rejects re-adding a target with the same name', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-filtered',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });
});
