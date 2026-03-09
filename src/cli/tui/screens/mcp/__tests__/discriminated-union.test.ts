import type {
  AddGatewayTargetConfig,
  ApiGatewayTargetConfig,
  McpServerTargetConfig,
  SchemaBasedTargetConfig,
} from '../types.js';
import { describe, expect, it } from 'vitest';

describe('AddGatewayTargetConfig discriminated union', () => {
  it('narrows to McpServerTargetConfig when targetType is mcpServer', () => {
    const config: AddGatewayTargetConfig = {
      targetType: 'mcpServer',
      name: 'my-tool',
      description: 'A tool',
      endpoint: 'https://example.com/mcp',
      gateway: 'my-gateway',
      toolDefinition: { name: 'my-tool', description: 'A tool', inputSchema: { type: 'object' } },
    };

    if (config.targetType === 'mcpServer') {
      // TypeScript narrows — these are required fields, no ! needed
      expect(config.endpoint).toBe('https://example.com/mcp');
      expect(config.description).toBe('A tool');
      expect(config.toolDefinition.name).toBe('my-tool');
      expect(config.gateway).toBe('my-gateway');
    }
  });

  it('narrows to ApiGatewayTargetConfig when targetType is apiGateway', () => {
    const config: AddGatewayTargetConfig = {
      targetType: 'apiGateway',
      name: 'my-api',
      gateway: 'my-gateway',
      restApiId: 'abc123',
      stage: 'prod',
      toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
    };

    if (config.targetType === 'apiGateway') {
      expect(config.restApiId).toBe('abc123');
      expect(config.stage).toBe('prod');
      expect(config.gateway).toBe('my-gateway');
    }
  });

  it('McpServerTargetConfig requires all fields', () => {
    const config: McpServerTargetConfig = {
      targetType: 'mcpServer',
      name: 'test',
      description: 'desc',
      endpoint: 'https://example.com',
      gateway: 'gw',
      toolDefinition: { name: 'test', description: 'desc', inputSchema: { type: 'object' } },
    };
    expect(config.targetType).toBe('mcpServer');
    expect(config.outboundAuth).toBeUndefined();
  });

  it('ApiGatewayTargetConfig requires all fields', () => {
    const config: ApiGatewayTargetConfig = {
      targetType: 'apiGateway',
      name: 'test',
      gateway: 'gw',
      restApiId: 'id',
      stage: 'prod',
    };
    expect(config.targetType).toBe('apiGateway');
    expect(config.toolFilters).toBeUndefined();
  });

  it('McpServerTargetConfig accepts optional outboundAuth', () => {
    const config: McpServerTargetConfig = {
      targetType: 'mcpServer',
      name: 'test',
      description: 'desc',
      endpoint: 'https://example.com',
      gateway: 'gw',
      toolDefinition: { name: 'test', description: 'desc', inputSchema: { type: 'object' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    };
    expect(config.outboundAuth?.type).toBe('OAUTH');
  });

  it('narrows to SchemaBasedTargetConfig when targetType is openApiSchema', () => {
    const config: AddGatewayTargetConfig = {
      targetType: 'openApiSchema',
      name: 'petstore',
      gateway: 'my-gateway',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
    };

    if (config.targetType === 'openApiSchema' || config.targetType === 'smithyModel') {
      expect(config.schemaSource).toEqual({ inline: { path: 'specs/petstore.json' } });
      expect(config.gateway).toBe('my-gateway');
    }
  });

  it('SchemaBasedTargetConfig requires all fields', () => {
    const config: SchemaBasedTargetConfig = {
      targetType: 'openApiSchema',
      name: 'test',
      gateway: 'gw',
      schemaSource: { s3: { uri: 's3://bucket/key.json' } },
    };
    expect(config.targetType).toBe('openApiSchema');
    expect(config.outboundAuth).toBeUndefined();
  });

  it('SchemaBasedTargetConfig accepts smithyModel', () => {
    const config: SchemaBasedTargetConfig = {
      targetType: 'smithyModel',
      name: 'test',
      gateway: 'gw',
      schemaSource: { inline: { path: 'model.json' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    };
    expect(config.targetType).toBe('smithyModel');
    expect(config.outboundAuth?.type).toBe('OAUTH');
  });

  it('dispatches correctly based on targetType', () => {
    const configs: AddGatewayTargetConfig[] = [
      {
        targetType: 'mcpServer',
        name: 'mcp',
        description: 'd',
        endpoint: 'https://e.com',
        gateway: 'gw',
        toolDefinition: { name: 'mcp', description: 'd', inputSchema: { type: 'object' } },
      },
      {
        targetType: 'apiGateway',
        name: 'apigw',
        gateway: 'gw',
        restApiId: 'id',
        stage: 'prod',
      },
      {
        targetType: 'openApiSchema',
        name: 'openapi',
        gateway: 'gw',
        schemaSource: { inline: { path: 'spec.json' } },
      },
    ];

    const results = configs.map(c => {
      if (c.targetType === 'mcpServer') return `mcp:${c.endpoint}`;
      if (c.targetType === 'openApiSchema' || c.targetType === 'smithyModel') return `schema:${c.name}`;
      if (c.targetType === 'apiGateway') return `apigw:${c.restApiId}/${c.stage}`;
      return `unknown:${c.name}`;
    });

    expect(results).toEqual(['mcp:https://e.com', 'apigw:id/prod', 'schema:openapi']);
  });
});
