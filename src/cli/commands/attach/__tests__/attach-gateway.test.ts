import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('attach gateway command', () => {
  let testDir: string;
  let projectDir: string;
  const agentName = 'TestAgent';
  const gatewayName = 'TestGateway';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-gateway-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachGatewayProj';
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

    // Add gateway
    result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create gateway: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires agent flag', async () => {
      const result = await runCLI(['attach', 'gateway', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--agent'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires gateway flag', async () => {
      const result = await runCLI(['attach', 'gateway', '--agent', agentName, '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--gateway'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('attach operations', () => {
    it('attaches gateway to agent', async () => {
      const result = await runCLI(
        ['attach', 'gateway', '--agent', agentName, '--gateway', gatewayName, '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.agentName).toBe(agentName);
      expect(json.gatewayName).toBe(gatewayName);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      const mcpProvider = agent?.mcpProviders?.find((p: { gatewayName?: string }) => p.gatewayName === gatewayName);
      expect(mcpProvider, 'MCPProvider should be on agent').toBeTruthy();
      expect(mcpProvider.type).toBe('AgentCoreGateway');
    });

    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['attach', 'gateway', '--agent', 'NonExistent', '--gateway', gatewayName, '--json'],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });
});
