import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add gateway command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-gateway-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project first
    const projectName = 'TestProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('basic gateway', () => {
    it('creates gateway with default authorizer', async () => {
      const gatewayName = `gw-${Date.now()}`;
      const result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.gatewayName).toBe(gatewayName);

      // Verify gateway in mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      expect(gateway, 'Gateway should be in mcp.json').toBeTruthy();
      expect(gateway.authorizerType).toBe('NONE');
    });

    it('requires name flag', async () => {
      const result = await runCLI(['add', 'gateway', '--json'], projectDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });

    it('validates gateway name format', async () => {
      const result = await runCLI(['add', 'gateway', '--name', 'invalid name!', '--json'], projectDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });

    it('rejects duplicate gateway name', async () => {
      const gatewayName = 'dup-gateway';

      // First creation should succeed
      const first = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);
      expect(first.exitCode, `First should succeed: ${first.stdout}`).toBe(0);

      // Second creation should fail
      const second = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);

      expect(second.exitCode).toBe(1);
      const json = JSON.parse(second.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('already exists'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('JWT authorizer', () => {
    it('creates gateway with CUSTOM_JWT authorizer', async () => {
      const gatewayName = `jwt-gw-${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'gateway',
          '--name',
          gatewayName,
          '--authorizer-type',
          'CUSTOM_JWT',
          '--discovery-url',
          'https://example.com/.well-known/openid-configuration',
          '--allowed-audience',
          'aud1,aud2',
          '--allowed-clients',
          'client1',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify JWT config in mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      expect(gateway, 'Gateway should be in mcp.json').toBeTruthy();
      expect(gateway.authorizerType).toBe('CUSTOM_JWT');
      expect(gateway.authorizerConfiguration?.customJwtAuthorizer, 'Should have JWT config').toBeTruthy();
    });

    it('requires JWT fields when CUSTOM_JWT', async () => {
      const result = await runCLI(
        ['add', 'gateway', '--name', 'no-jwt', '--authorizer-type', 'CUSTOM_JWT', '--json'],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('discovery-url'), `Error: ${json.error}`).toBeTruthy();
    });

    it('validates discovery URL format', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway',
          '--name',
          'bad-url',
          '--authorizer-type',
          'CUSTOM_JWT',
          '--discovery-url',
          'https://example.com/wrong',
          '--allowed-audience',
          'aud',
          '--allowed-clients',
          'client',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('well-known'), `Error: ${json.error}`).toBeTruthy();
    });
  });
});
