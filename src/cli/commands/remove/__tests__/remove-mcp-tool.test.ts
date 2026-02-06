import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// MCP Tool feature is disabled (coming soon) - skip all tests
describe.skip('remove mcp-tool command', () => {
  let testDir: string;
  let projectDir: string;
  const agentName = 'TestAgent';
  const runtimeToolName = 'RuntimeTool';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-mcp-tool-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveMcpToolProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add agent
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

    // Add mcp-runtime tool
    result = await runCLI(
      [
        'add',
        'mcp-tool',
        '--name',
        runtimeToolName,
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
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create runtime tool: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'mcp-tool', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent tool', async () => {
      const result = await runCLI(['remove', 'mcp-tool', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove mcp-runtime tool', () => {
    it('removes mcp-runtime tool and cleans up agent references', async () => {
      // Add a temp tool to remove
      const tempTool = `tempRt${Date.now()}`;
      await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          tempTool,
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

      const result = await runCLI(['remove', 'mcp-tool', '--name', tempTool, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify tool is removed from mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const tool = mcpSpec.mcpRuntimeTools?.find((t: { name: string }) => t.name === tempTool);
      expect(!tool, 'Tool should be removed from mcpRuntimeTools').toBeTruthy();

      // Verify agent reference is cleaned up
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      const hasRef = agent?.remoteTools?.some((rt: { mcpRuntimeName?: string }) => rt.mcpRuntimeName === tempTool);
      expect(!hasRef, 'Agent should not have reference to removed tool').toBeTruthy();
    });
  });

  // Gateway disabled - skip behind-gateway tests until gateway feature is enabled
  describe.skip('remove behind-gateway tool', () => {
    it('removes behind-gateway tool from gateway targets', async () => {
      // Create a fresh gateway for this test to avoid conflicts with existing tools
      const tempGateway = `TempGw${Date.now()}`;
      const gwResult = await runCLI(['add', 'gateway', '--name', tempGateway, '--json'], projectDir);
      expect(gwResult.exitCode, `gateway add failed: ${gwResult.stdout}`).toBe(0);

      // Add a tool to the fresh gateway
      const tempTool = `tempTool${Date.now()}`;
      const addResult = await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          tempTool,
          '--language',
          'Python',
          '--exposure',
          'behind-gateway',
          '--gateway',
          tempGateway,
          '--host',
          'Lambda',
          '--json',
        ],
        projectDir
      );
      expect(addResult.exitCode, `add failed: ${addResult.stdout} ${addResult.stderr}`).toBe(0);

      const result = await runCLI(['remove', 'mcp-tool', '--name', tempTool, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify tool is removed from gateway targets
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === tempGateway);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === tempTool);
      expect(!target, 'Tool should be removed from gateway targets').toBeTruthy();
    });
  });
});
