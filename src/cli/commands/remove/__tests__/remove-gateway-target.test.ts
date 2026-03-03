import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove gateway-target command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-gateway-target-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveGatewayTargetProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'gateway-target', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('rejects non-existent tool', async () => {
      const result = await runCLI(['remove', 'gateway-target', '--name', 'nonexistent', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('remove existing-endpoint target', () => {
    it('removes target from gateway', async () => {
      // Create a fresh gateway
      const tempGateway = `TempGw${Date.now()}`;
      const gwResult = await runCLI(['add', 'gateway', '--name', tempGateway, '--json'], projectDir);
      expect(gwResult.exitCode, `gateway add failed: ${gwResult.stdout}`).toBe(0);

      // Add a target to the gateway
      const tempTool = `tempTool${Date.now()}`;
      const addResult = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          tempTool,
          '--endpoint',
          'https://example.com/mcp',
          '--gateway',
          tempGateway,
          '--json',
        ],
        projectDir
      );
      expect(addResult.exitCode, `add failed: ${addResult.stdout} ${addResult.stderr}`).toBe(0);

      const result = await runCLI(['remove', 'gateway-target', '--name', tempTool, '--json'], projectDir);
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
