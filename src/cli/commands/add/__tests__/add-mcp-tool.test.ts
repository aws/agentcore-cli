import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// MCP Tool feature is disabled (coming soon) - skip all tests
describe.skip('add mcp-tool command', () => {
  let testDir: string;
  let projectDir: string;
  const agentName = 'TestAgent';
  const gatewayName = 'test-gateway'; // Used in skipped behind-gateway tests

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-mcp-tool-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent
    const projectName = 'McpToolProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add agent for mcp-runtime tests
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentName,
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
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create agent: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['add', 'mcp-tool', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires exposure flag', async () => {
      const result = await runCLI(['add', 'mcp-tool', '--name', 'test', '--language', 'Python', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--exposure'), `Error: ${json.error}`).toBeTruthy();
    });

    it('validates language', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'test',
          '--language',
          'InvalidLang',
          '--exposure',
          'mcp-runtime',
          '--agents',
          agentName,
          '--json',
        ],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('invalid') || json.error.toLowerCase().includes('valid options'),
        `Error should mention invalid language: ${json.error}`
      ).toBeTruthy();
    });

    it('accepts Other as valid language option', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'container-tool',
          '--language',
          'Other',
          '--exposure',
          'mcp-runtime',
          '--agents',
          agentName,
          '--json',
        ],
        projectDir
      );

      // Should fail with "not yet supported" error, not validation error
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(
        json.error.toLowerCase().includes('not yet supported') || json.error.toLowerCase().includes('other'),
        `Error should mention Other not supported: ${json.error}`
      ).toBeTruthy();
    });
  });

  describe('mcp-runtime', () => {
    it('creates mcp-runtime tool', async () => {
      const toolName = `rttool${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          toolName,
          '--language',
          'Python',
          '--exposure',
          'mcp-runtime',
          '--agents',
          agentName,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(toolName);

      // Verify in mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const tool = mcpSpec.mcpRuntimeTools?.find((t: { name: string }) => t.name === toolName);
      expect(tool, 'Tool should be in mcpRuntimeTools').toBeTruthy();

      // Verify agent has remote tool reference
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      const hasRef = agent?.remoteTools?.some((rt: { mcpRuntimeName?: string }) => rt.mcpRuntimeName === toolName);
      expect(hasRef, 'Agent should have remoteTools reference').toBeTruthy();
    });

    it('requires agents for mcp-runtime', async () => {
      const result = await runCLI(
        ['add', 'mcp-tool', '--name', 'no-agents', '--language', 'Python', '--exposure', 'mcp-runtime', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--agents'), `Error: ${json.error}`).toBeTruthy();
    });

    it('returns clear error for Other language with mcp-runtime', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'runtime-container',
          '--language',
          'Other',
          '--exposure',
          'mcp-runtime',
          '--agents',
          agentName,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.length > 0, 'Should have error message').toBeTruthy();
    });
  });

  // Gateway disabled - skip behind-gateway tests until gateway feature is enabled
  describe.skip('behind-gateway', () => {
    it('creates behind-gateway tool', async () => {
      const toolName = `gwtool${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          toolName,
          '--language',
          'Python',
          '--exposure',
          'behind-gateway',
          '--gateway',
          gatewayName,
          '--host',
          'Lambda',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(toolName);

      // Verify in mcp.json gateway targets
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === toolName);
      expect(target, 'Tool should be in gateway targets').toBeTruthy();
    });

    it('requires gateway for behind-gateway', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'no-gw',
          '--language',
          'Python',
          '--exposure',
          'behind-gateway',
          '--host',
          'Lambda',
          '--json',
        ],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--gateway'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires host for behind-gateway', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'no-host',
          '--language',
          'Python',
          '--exposure',
          'behind-gateway',
          '--gateway',
          gatewayName,
          '--json',
        ],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--host'), `Error: ${json.error}`).toBeTruthy();
    });

    it('returns clear error for Other language with behind-gateway', async () => {
      const result = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          'gateway-container',
          '--language',
          'Other',
          '--exposure',
          'behind-gateway',
          '--gateway',
          gatewayName,
          '--host',
          'Lambda',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.length > 0, 'Should have error message').toBeTruthy();
    });
  });
});
