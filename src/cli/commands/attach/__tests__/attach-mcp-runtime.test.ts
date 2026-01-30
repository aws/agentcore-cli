import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('attach mcp-runtime command', () => {
  let testDir: string;
  let projectDir: string;
  const agentA = 'AgentA';
  const agentB = 'AgentB';
  const toolName = 'testtool';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-mcp-runtime-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachMcpRuntimeProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add AgentA
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentA,
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
      throw new Error(`Failed to create AgentA: ${result.stdout} ${result.stderr}`);
    }

    // Add AgentB
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentB,
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
      throw new Error(`Failed to create AgentB: ${result.stdout} ${result.stderr}`);
    }

    // Add MCP tool with mcp-runtime exposure attached to AgentA
    result = await runCLI(
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
        agentA,
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create MCP tool: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires agent flag', async () => {
      const result = await runCLI(['attach', 'mcp-runtime', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--agent'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires runtime flag', async () => {
      const result = await runCLI(['attach', 'mcp-runtime', '--agent', agentB, '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--runtime'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('bind operations', () => {
    it('binds agent to MCP runtime', async () => {
      const result = await runCLI(
        ['attach', 'mcp-runtime', '--agent', agentB, '--runtime', toolName, '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.agentName).toBe(agentB);
      expect(json.runtimeName).toBe(toolName);

      // Verify in mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const runtime = mcpSpec.mcpRuntimeTools?.find((t: { name: string }) => t.name === toolName);
      expect(runtime, 'Runtime should exist in mcp.json').toBeTruthy();
      const binding = runtime.bindings?.find((b: { agentName: string }) => b.agentName === agentB);
      expect(binding, 'AgentB binding should exist').toBeTruthy();
      expect(binding.envVarName, 'Binding should have envVarName').toBeTruthy();
    });

    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['attach', 'mcp-runtime', '--agent', 'NonExistent', '--runtime', toolName, '--json'],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent runtime', async () => {
      const result = await runCLI(
        ['attach', 'mcp-runtime', '--agent', agentB, '--runtime', 'nonexistent', '--json'],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });
});
