import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Gateway disabled - skip until gateway feature is enabled
describe.skip('remove gateway command', () => {
  let testDir: string;
  let projectDir: string;
  const gatewayName = 'TestGateway';
  const agentName = 'TestAgent';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-gateway-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveGatewayProj';
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
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'gateway', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent gateway', async () => {
      const result = await runCLI(['remove', 'gateway', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove operations', () => {
    it('removes gateway without dependencies', async () => {
      // Add a second gateway to remove
      const tempGateway = `tempGw${Date.now()}`;
      await runCLI(['add', 'gateway', '--name', tempGateway, '--json'], projectDir);

      const result = await runCLI(['remove', 'gateway', '--name', tempGateway, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify gateway is removed
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === tempGateway);
      expect(!gateway, 'Gateway should be removed').toBeTruthy();
    });

    it('removes gateway with attached agents using cascade policy (default)', async () => {
      // Attach gateway to agent
      await runCLI(['attach', 'gateway', '--agent', agentName, '--gateway', gatewayName, '--json'], projectDir);

      // Remove with cascade policy (default) - should succeed and clean up references
      const result = await runCLI(['remove', 'gateway', '--name', gatewayName, '--json'], projectDir);
      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify gateway is removed from mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      expect(mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName)).toBeUndefined();
    });
  });
});
