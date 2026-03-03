import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add gateway-target command', () => {
  let testDir: string;
  let projectDir: string;
  const gatewayName = 'test-gateway';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-gateway-target-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'GatewayTargetProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Create gateway for tests
    const gwResult = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);
    if (gwResult.exitCode !== 0) {
      throw new Error(`Failed to create gateway: ${gwResult.stdout} ${gwResult.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['add', 'gateway-target', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires endpoint', async () => {
      const result = await runCLI(
        ['add', 'gateway-target', '--name', 'noendpoint', '--gateway', gatewayName, '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--endpoint'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('existing-endpoint', () => {
    it('adds existing-endpoint target to gateway', async () => {
      const targetName = `target${Date.now()}`;
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
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify in mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, 'Target should be in gateway targets').toBeTruthy();
    });
  });
});
