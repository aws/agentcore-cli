import type { AddGatewayTargetConfig, ApiGatewayTargetConfig, McpServerTargetConfig } from '../types.js';
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
    ];

    const results = configs.map(c => {
      if (c.targetType === 'mcpServer') return `mcp:${c.endpoint}`;
      return `apigw:${c.restApiId}/${c.stage}`;
    });

    expect(results).toEqual(['mcp:https://e.com', 'apigw:id/prod']);
  });
});
