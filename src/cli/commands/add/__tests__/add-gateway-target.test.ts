import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
        ['add', 'gateway-target', '--name', 'noendpoint', '--type', 'mcp-server', '--gateway', gatewayName, '--json'],
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
          '--type',
          'mcp-server',
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

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const gateway = projectSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, 'Target should be in gateway targets').toBeTruthy();
    });
  });

  describe('lambda-function-arn', () => {
    const lambdaArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-func';

    beforeAll(async () => {
      await writeFile(
        join(projectDir, 'tools.json'),
        JSON.stringify([{ name: 'myTool', description: 'A test tool', inputSchema: { type: 'object' } }])
      );
    });

    it('adds lambda-function-arn target successfully', async () => {
      const targetName = `lambda-target-${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--type',
          'lambda-function-arn',
          '--name',
          targetName,
          '--lambda-arn',
          lambdaArn,
          '--tool-schema-file',
          './tools.json',
          '--gateway',
          gatewayName,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(targetName);

      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const gateway = projectSpec.agentCoreGateways.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target).toBeTruthy();
      expect(target.targetType).toBe('lambdaFunctionArn');
      expect(target.lambdaFunctionArn).toEqual({ lambdaArn, toolSchemaFile: './tools.json' });
    });

    it('rejects missing --lambda-arn', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--type',
          'lambda-function-arn',
          '--name',
          `no-arn-${Date.now()}`,
          '--tool-schema-file',
          './tools.json',
          '--gateway',
          gatewayName,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--lambda-arn');
    });

    it('rejects missing --tool-schema-file', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--type',
          'lambda-function-arn',
          '--name',
          `no-schema-${Date.now()}`,
          '--lambda-arn',
          lambdaArn,
          '--gateway',
          gatewayName,
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--tool-schema-file');
    });

    it('removes lambda-function-arn target', async () => {
      const targetName = `lambda-rm-${Date.now()}`;
      const addResult = await runCLI(
        [
          'add',
          'gateway-target',
          '--type',
          'lambda-function-arn',
          '--name',
          targetName,
          '--lambda-arn',
          lambdaArn,
          '--tool-schema-file',
          './tools.json',
          '--gateway',
          gatewayName,
          '--json',
        ],
        projectDir
      );
      expect(addResult.exitCode, `add stdout: ${addResult.stdout}, stderr: ${addResult.stderr}`).toBe(0);

      const removeResult = await runCLI(
        ['remove', 'gateway-target', '--name', targetName, '--force', '--json'],
        projectDir
      );
      expect(removeResult.exitCode, `remove stdout: ${removeResult.stdout}, stderr: ${removeResult.stderr}`).toBe(0);
      const json = JSON.parse(removeResult.stdout);
      expect(json.success).toBe(true);
    });
  });
});
