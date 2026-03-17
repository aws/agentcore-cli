/* eslint-disable security/detect-non-literal-fs-filename */
import { exists, prereqs, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!prereqs.npm || !prereqs.git)('integration: create with protocol modes', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-protocols-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates MCP standalone project (no framework, no model provider)', async () => {
    const name = `Mcp${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      ['create', '--name', name, '--language', 'Python', '--protocol', 'MCP', '--json'],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'main.py')), 'main.py should exist').toBe(true);
    expect(await exists(join(agentDir, 'pyproject.toml')), 'pyproject.toml should exist').toBe(true);

    // Verify pyproject.toml references mcp (FastMCP)
    const pyproject = await readFile(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(pyproject.toLowerCase().includes('mcp'), 'pyproject.toml should reference mcp').toBe(true);

    // Verify config has protocol set to MCP
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents).toBeDefined();
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe(agentName);
    expect(agents[0]!.protocol).toBe('MCP');

    // MCP agents should have no credentials
    const credentials = (config.credentials as Record<string, unknown>[]) ?? [];
    expect(credentials.length).toBe(0);
  });

  it('creates A2A project with Strands framework', async () => {
    const name = `A2a${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--protocol',
        'A2A',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'main.py')), 'main.py should exist').toBe(true);

    // Verify config has protocol set to A2A
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents.length).toBe(1);
    expect(agents[0]!.protocol).toBe('A2A');
  });

  it('creates HTTP project with explicit protocol HTTP', async () => {
    const name = `Http${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify config has explicit protocol: HTTP
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents.length).toBe(1);
    expect(agents[0]!.protocol).toBe('HTTP');
  });

  it('rejects invalid protocol', async () => {
    const name = `Bad${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      ['create', '--name', name, '--language', 'Python', '--protocol', 'INVALID', '--json'],
      testDir
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects MCP with --framework flag', async () => {
    const name = `McpFw${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      ['create', '--name', name, '--language', 'Python', '--protocol', 'MCP', '--framework', 'Strands', '--json'],
      testDir
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects A2A with unsupported framework (CrewAI)', async () => {
    const name = `A2aCrew${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--protocol',
        'A2A',
        '--framework',
        'CrewAI',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode).not.toBe(0);
  });
});

describe.skipIf(!prereqs.npm || !prereqs.git)('integration: add agent with protocol modes', () => {
  let testDir: string;
  let projectPath: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-add-protocol-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a base project first (HTTP, no agent)
    const result = await runCLI(['create', '--name', 'ProtoTest', '--no-agent', '--json'], testDir);
    expect(result.exitCode, `setup stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    projectPath = json.projectPath;
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds MCP agent to existing project', async () => {
    const name = `McpAgent${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      ['add', 'agent', '--name', name, '--protocol', 'MCP', '--language', 'Python', '--json'],
      projectPath
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(projectPath);
    const agents = config.agents as Record<string, unknown>[];
    const mcpAgent = agents.find(a => a.name === name);
    expect(mcpAgent).toBeDefined();
    expect(mcpAgent!.protocol).toBe('MCP');
  });

  it('adds A2A agent to existing project', async () => {
    const name = `A2aAgent${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        name,
        '--protocol',
        'A2A',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--language',
        'Python',
        '--json',
      ],
      projectPath
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(projectPath);
    const agents = config.agents as Record<string, unknown>[];
    const a2aAgent = agents.find(a => a.name === name);
    expect(a2aAgent).toBeDefined();
    expect(a2aAgent!.protocol).toBe('A2A');
  });

  it('adds BYO agent with MCP protocol', async () => {
    const name = `ByoMcp${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        name,
        '--type',
        'byo',
        '--protocol',
        'MCP',
        '--language',
        'Python',
        '--code-location',
        `app/${name}/`,
        '--json',
      ],
      projectPath
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(projectPath);
    const agents = config.agents as Record<string, unknown>[];
    const byoAgent = agents.find(a => a.name === name);
    expect(byoAgent).toBeDefined();
    expect(byoAgent!.protocol).toBe('MCP');
  });
});
