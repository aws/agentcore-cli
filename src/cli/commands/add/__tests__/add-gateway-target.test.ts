import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Gateway Target feature is disabled (coming soon) - skip all tests
describe.skip('add gateway-target command', () => {
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

    it('validates language', async () => {
      const result = await runCLI(
        ['add', 'gateway-target', '--name', 'test', '--language', 'InvalidLang', '--json'],
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
        ['add', 'gateway-target', '--name', 'container-tool', '--language', 'Other', '--json'],
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

  // Gateway disabled - skip behind-gateway tests until gateway feature is enabled
  describe.skip('behind-gateway', () => {
    it('creates behind-gateway tool', async () => {
      const toolName = `gwtool${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          toolName,
          '--language',
          'Python',
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
        ['add', 'gateway-target', '--name', 'no-gw', '--language', 'Python', '--host', 'Lambda', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--gateway'), `Error: ${json.error}`).toBeTruthy();
    });

    it('requires host for behind-gateway', async () => {
      const result = await runCLI(
        ['add', 'gateway-target', '--name', 'no-host', '--language', 'Python', '--gateway', gatewayName, '--json'],
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
          'gateway-target',
          '--name',
          'gateway-container',
          '--language',
          'Other',
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
