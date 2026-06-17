import type {
  AddGatewayTargetConfig,
  ApiGatewayTargetConfig,
  BedrockKnowledgeBasesConnectorTargetConfig,
  LambdaFunctionArnTargetConfig,
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
      if (c.targetType === 'lambdaFunctionArn') return `lambda:${c.lambdaArn}`;
      return `unknown:${c.name}`;
    });

    expect(results).toEqual(['mcp:https://e.com', 'apigw:id/prod', 'schema:openapi']);
  });

  it('narrows to LambdaFunctionArnTargetConfig when targetType is lambdaFunctionArn', () => {
    const config: AddGatewayTargetConfig = {
      targetType: 'lambdaFunctionArn',
      name: 'my-lambda',
      gateway: 'my-gateway',
      lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
      toolSchemaFile: 'tools/schema.json',
    };

    if (config.targetType === 'lambdaFunctionArn') {
      expect(config.lambdaArn).toBe('arn:aws:lambda:us-east-1:123456789012:function:my-fn');
      expect(config.toolSchemaFile).toBe('tools/schema.json');
      expect(config.gateway).toBe('my-gateway');
    }
  });

  it('LambdaFunctionArnTargetConfig requires all fields', () => {
    const config: LambdaFunctionArnTargetConfig = {
      targetType: 'lambdaFunctionArn',
      name: 'test',
      gateway: 'gw',
      lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
      toolSchemaFile: 'schema.json',
    };
    expect(config.targetType).toBe('lambdaFunctionArn');
  });

  it('narrows to BedrockKnowledgeBasesConnectorTargetConfig when targetType is connector', () => {
    const config: AddGatewayTargetConfig = {
      targetType: 'connector',
      connectorId: 'bedrock-knowledge-bases',
      name: 'kb-target',
      gateway: 'my-gateway',
      knowledgeBaseId: 'my-project-kb',
    };

    if (config.targetType === 'connector') {
      // TypeScript narrows on the connectorId discriminator inside the union.
      if (config.connectorId === 'bedrock-knowledge-bases') {
        expect(config.knowledgeBaseId).toBe('my-project-kb');
        expect(config.gateway).toBe('my-gateway');
      }
    }
  });

  it('BedrockKnowledgeBasesConnectorTargetConfig accepts a literal 10-char external KB ID', () => {
    const config: BedrockKnowledgeBasesConnectorTargetConfig = {
      targetType: 'connector',
      connectorId: 'bedrock-knowledge-bases',
      name: 'kb-target',
      gateway: 'gw',
      knowledgeBaseId: 'ABCDE12345',
    };
    expect(config.connectorId).toBe('bedrock-knowledge-bases');
    expect(config.knowledgeBaseId).toBe('ABCDE12345');
  });

  it('three-way dispatch handles all target types', () => {
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
        targetType: 'lambdaFunctionArn',
        name: 'lambda',
        gateway: 'gw',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
        toolSchemaFile: 'schema.json',
      },
    ];

    const results = configs.map(c => {
      switch (c.targetType) {
        case 'mcpServer':
          return `mcp:${c.endpoint}`;
        case 'apiGateway':
          return `apigw:${c.restApiId}/${c.stage}`;
        case 'lambdaFunctionArn':
          return `lambda:${c.lambdaArn}`;
      }
    });

    expect(results).toEqual([
      'mcp:https://e.com',
      'apigw:id/prod',
      'lambda:arn:aws:lambda:us-east-1:123456789012:function:fn',
    ]);
  });
});
