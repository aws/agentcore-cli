import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

interface WebSearchTarget {
  name: string;
  targetType: string;
  excludeDomains?: string[];
}

interface Gateway {
  name: string;
  targets?: WebSearchTarget[];
}

async function readProjectConfig(projectPath: string) {
  return JSON.parse(await readFile(join(projectPath, 'agentcore/agentcore.json'), 'utf-8'));
}

async function findTarget(
  projectPath: string,
  gatewayName: string,
  targetName: string
): Promise<WebSearchTarget | undefined> {
  const config = await readProjectConfig(projectPath);
  const gateway = (config.agentCoreGateways as Gateway[]).find(g => g.name === gatewayName);
  return gateway?.targets?.find(t => t.name === targetName);
}

describe('integration: add and remove web-search via gateway-target form', () => {
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

  it('adds a web-search target with no excludeDomains', async () => {
    const result = await runCLI(
      ['add', 'gateway-target', '--type', 'web-search', '--gateway', gatewayName, '--name', 'ws-plain', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const target = await findTarget(project.projectPath, gatewayName, 'ws-plain');
    expect(target).toBeTruthy();
    expect(target?.targetType).toBe('webSearch');
    expect(target?.excludeDomains).toBeUndefined();
    telemetry.assertMetricEmitted({ command: 'add.gateway-target', exit_reason: 'success' });
  });

  it('adds a web-search target with --exclude-domains', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
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
    expect(target?.excludeDomains).toEqual(['foo.com', 'bar.net']);
  });

  it('trims whitespace in --exclude-domains values', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
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
    expect(target?.excludeDomains).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('rejects repeated --exclude-domains', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
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

  it('rejects re-adding a target with the same name as an existing one', async () => {
    const result = await runCLI(
      ['add', 'gateway-target', '--type', 'web-search', '--gateway', gatewayName, '--name', 'ws-filtered', '--json'],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });
});

describe('integration: add and remove web-search via top-level shortcut', () => {
  let project: TestProject;
  const gatewayName = 'WsShortcutGateway';

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

  it('add web-search produces the same spec shape as the long-form path', async () => {
    const result = await runCLI(
      ['add', 'web-search', '--gateway', gatewayName, '--name', 'ws1', '--json'],
      project.projectPath,
      { env: telemetry.env }
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'ws1');
    expect(target?.targetType).toBe('webSearch');
    expect(target?.excludeDomains).toBeUndefined();
    telemetry.assertMetricEmitted({ command: 'add.web-search', exit_reason: 'success' });
  });

  it('add web-search defaults --name to "web-search" when omitted', async () => {
    const result = await runCLI(['add', 'web-search', '--gateway', gatewayName, '--json'], project.projectPath);

    expect(result.exitCode).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'web-search');
    expect(target?.targetType).toBe('webSearch');
  });

  it('rejects a second default-name add when "web-search" already exists', async () => {
    const result = await runCLI(['add', 'web-search', '--gateway', gatewayName, '--json'], project.projectPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });

  it('add web-search persists --exclude-domains', async () => {
    const result = await runCLI(
      [
        'add',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        'ws-with-filter',
        '--exclude-domains',
        'example.com,blocked.org',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'ws-with-filter');
    expect(target?.excludeDomains).toEqual(['example.com', 'blocked.org']);
  });

  it('remove web-search --name removes the target', async () => {
    const result = await runCLI(['remove', 'web-search', '--name', 'ws1', '--yes', '--json'], project.projectPath, {
      env: telemetry.env,
    });

    expect(result.exitCode).toBe(0);
    const target = await findTarget(project.projectPath, gatewayName, 'ws1');
    expect(target).toBeUndefined();
    telemetry.assertMetricEmitted({ command: 'remove.web-search', exit_reason: 'success' });
  });

  it('remove web-search rejects an unknown target name', async () => {
    const result = await runCLI(['remove', 'web-search', '--name', 'does-not-exist', '--json'], project.projectPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('not found');
  });

  it('remove web-search rejects a non-webSearch target name', async () => {
    const addMcp = await runCLI(
      [
        'add',
        'gateway-target',
        '--type',
        'mcp-server',
        '--gateway',
        gatewayName,
        '--name',
        'mcp-tmp',
        '--endpoint',
        'https://example.com/mcp',
        '--json',
      ],
      project.projectPath
    );
    expect(addMcp.exitCode).toBe(0);

    const result = await runCLI(['remove', 'web-search', '--name', 'mcp-tmp', '--json'], project.projectPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('not webSearch');
    const stillThere = await findTarget(project.projectPath, gatewayName, 'mcp-tmp');
    expect(stillThere).toBeTruthy();
  });

  it('remove web-search without --name errors', async () => {
    const result = await runCLI(['remove', 'web-search', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--name is required');
  });
});
