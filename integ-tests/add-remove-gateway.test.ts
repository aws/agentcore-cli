import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function readMcpConfig(projectPath: string) {
  return JSON.parse(await readFile(join(projectPath, 'agentcore/mcp.json'), 'utf-8'));
}

describe('integration: add and remove gateway with external MCP server', () => {
  let project: TestProject;
  const gatewayName = 'ExaGateway';
  const targetName = 'ExaSearch';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('gateway lifecycle', () => {
    it('adds a gateway', async () => {
      const result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      expect(gateway, `Gateway "${gatewayName}" should be in mcp.json`).toBeTruthy();
      expect(gateway.authorizerType).toBe('NONE');
    });

    it('adds an external MCP server target to the gateway', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--endpoint',
          'https://mcp.exa.ai/mcp',
          '--gateway',
          gatewayName,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, `Target "${targetName}" should be in gateway targets`).toBeTruthy();
    });

    it('removes the gateway target', async () => {
      const result = await runCLI(['remove', 'gateway-target', '--name', targetName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const targets = gateway?.targets ?? [];
      const found = targets.find((t: { name: string }) => t.name === targetName);
      expect(found, `Target "${targetName}" should be removed`).toBeFalsy();
    });

    it('removes the gateway', async () => {
      const result = await runCLI(['remove', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateways = mcpSpec.agentCoreGateways ?? [];
      const found = gateways.find((g: { name: string }) => g.name === gatewayName);
      expect(found, `Gateway "${gatewayName}" should be removed`).toBeFalsy();
    });
  });
});
