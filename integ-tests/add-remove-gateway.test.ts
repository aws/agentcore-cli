import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile, writeFile } from 'node:fs/promises';
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
          '--type',
          'mcp-server',
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

describe('integration: add and remove gateway with OpenAPI schema target', () => {
  let project: TestProject;
  const gatewayName = 'OpenApiGateway';
  const targetName = 'PetstoreApi';
  const schemaFileName = 'petstore.json';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('openApiSchema lifecycle', () => {
    it('adds a gateway', async () => {
      const result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('adds an OpenAPI schema target with a local file', async () => {
      // Write a minimal OpenAPI schema file in the project root
      const schemaContent = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Petstore', version: '1.0.0' },
        paths: { '/pets': { get: { summary: 'List pets', operationId: 'listPets' } } },
      });
      await writeFile(join(project.projectPath, schemaFileName), schemaContent, 'utf-8');

      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--type',
          'open-api-schema',
          '--schema',
          `./${schemaFileName}`,
          '--gateway',
          gatewayName,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(targetName);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, `Target "${targetName}" should be in gateway targets`).toBeTruthy();
      expect(target.targetType).toBe('openApiSchema');
      expect(target.schemaSource?.inline?.path).toBe(`./${schemaFileName}`);
    });

    it('rejects duplicate target name', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--type',
          'open-api-schema',
          '--schema',
          `./${schemaFileName}`,
          '--gateway',
          gatewayName,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).not.toBe(0);
    });

    it('removes the OpenAPI schema target', async () => {
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
    });
  });
});

describe('integration: add gateway with S3 URI schema target', () => {
  let project: TestProject;
  const gatewayName = 'S3SchemaGateway';
  const targetName = 'S3Petstore';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('S3 URI openApiSchema lifecycle', () => {
    it('adds a gateway', async () => {
      const result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    });

    it('adds an OpenAPI schema target with an S3 URI', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--type',
          'open-api-schema',
          '--schema',
          's3://my-bucket/specs/petstore.json',
          '--gateway',
          gatewayName,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(targetName);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, `Target "${targetName}" should be in gateway targets`).toBeTruthy();
      expect(target.targetType).toBe('openApiSchema');
      expect(target.schemaSource?.s3?.uri).toBe('s3://my-bucket/specs/petstore.json');
    });

    it('removes the S3 schema target', async () => {
      const result = await runCLI(['remove', 'gateway-target', '--name', targetName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });
  });
});

describe('integration: add gateway with S3 URI and bucketOwnerAccountId', () => {
  let project: TestProject;
  const gatewayName = 'CrossAccountGateway';
  const targetName = 'CrossAccountApi';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds a gateway and target with --schema-s3-account', async () => {
    await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--name',
        targetName,
        '--type',
        'open-api-schema',
        '--schema',
        's3://cross-account-bucket/spec.json',
        '--schema-s3-account',
        '123456789012',
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
    expect(target.schemaSource?.s3?.uri).toBe('s3://cross-account-bucket/spec.json');
    expect(target.schemaSource?.s3?.bucketOwnerAccountId).toBe('123456789012');
  });
});

describe('integration: add gateway with Smithy model target', () => {
  let project: TestProject;
  const gatewayName = 'SmithyGateway';
  const targetName = 'SmithyService';
  const schemaFileName = 'service-model.json';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('smithyModel lifecycle', () => {
    it('adds a gateway', async () => {
      const result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    });

    it('adds a Smithy model target with a local file', async () => {
      const schemaContent = JSON.stringify({
        smithy: '2.0',
        shapes: { 'example#MyService': { type: 'service', version: '2024-01-01' } },
      });
      await writeFile(join(project.projectPath, schemaFileName), schemaContent, 'utf-8');

      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--type',
          'smithy-model',
          '--schema',
          `./${schemaFileName}`,
          '--gateway',
          gatewayName,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.toolName).toBe(targetName);

      const mcpSpec = await readMcpConfig(project.projectPath);
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === targetName);
      expect(target, `Target "${targetName}" should be in gateway targets`).toBeTruthy();
      expect(target.targetType).toBe('smithyModel');
      expect(target.schemaSource?.inline?.path).toBe(`./${schemaFileName}`);
    });

    it('removes the Smithy model target', async () => {
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
  });
});

describe('integration: schema-based target validation errors', () => {
  let project: TestProject;
  const gatewayName = 'ValidationGateway';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
    await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('rejects open-api-schema without --schema flag', async () => {
    const result = await runCLI(
      ['add', 'gateway-target', '--name', 'NoSchema', '--type', 'open-api-schema', '--gateway', gatewayName, '--json'],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects open-api-schema with non-existent local file', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--name',
        'BadFile',
        '--type',
        'open-api-schema',
        '--schema',
        './does-not-exist.json',
        '--gateway',
        gatewayName,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects open-api-schema with non-JSON file', async () => {
    await writeFile(join(project.projectPath, 'spec.yaml'), 'openapi: 3.0.0', 'utf-8');

    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--name',
        'YamlFile',
        '--type',
        'open-api-schema',
        '--schema',
        './spec.yaml',
        '--gateway',
        gatewayName,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects --schema-s3-account with local file', async () => {
    await writeFile(join(project.projectPath, 'local.json'), '{}', 'utf-8');

    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--name',
        'BadS3Account',
        '--type',
        'open-api-schema',
        '--schema',
        './local.json',
        '--schema-s3-account',
        '123456789012',
        '--gateway',
        gatewayName,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects open-api-schema with --endpoint flag', async () => {
    const result = await runCLI(
      [
        'add',
        'gateway-target',
        '--name',
        'WithEndpoint',
        '--type',
        'open-api-schema',
        '--schema',
        's3://bucket/spec.json',
        '--endpoint',
        'https://example.com',
        '--gateway',
        gatewayName,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });
});
