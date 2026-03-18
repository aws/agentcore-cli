import {
  AgentCoreGatewaySchema,
  AgentCoreGatewayTargetSchema,
  AgentCoreMcpRuntimeToolSchema,
  AgentCoreMcpSpecSchema,
  ApiGatewayConfigSchema,
  CustomJwtAuthorizerConfigSchema,
  GatewayAuthorizerTypeSchema,
  GatewayExceptionLevelSchema,
  GatewayTargetTypeSchema,
  LambdaFunctionArnConfigSchema,
  McpImplLanguageSchema,
  RuntimeConfigSchema,
  SchemaSourceSchema,
  ToolComputeConfigSchema,
  ToolImplementationBindingSchema,
} from '../mcp.js';
import { describe, expect, it } from 'vitest';

describe('GatewayTargetTypeSchema', () => {
  it.each(['lambda', 'mcpServer', 'openApiSchema', 'smithyModel', 'apiGateway', 'lambdaFunctionArn'])(
    'accepts "%s"',
    type => {
      expect(GatewayTargetTypeSchema.safeParse(type).success).toBe(true);
    }
  );

  it('rejects invalid type', () => {
    expect(GatewayTargetTypeSchema.safeParse('http').success).toBe(false);
  });
});

describe('GatewayAuthorizerTypeSchema', () => {
  it('accepts NONE', () => {
    expect(GatewayAuthorizerTypeSchema.safeParse('NONE').success).toBe(true);
  });

  it('accepts CUSTOM_JWT', () => {
    expect(GatewayAuthorizerTypeSchema.safeParse('CUSTOM_JWT').success).toBe(true);
  });

  it('rejects other types', () => {
    expect(GatewayAuthorizerTypeSchema.safeParse('IAM').success).toBe(false);
  });
});

describe('McpImplLanguageSchema', () => {
  it('accepts TypeScript', () => {
    expect(McpImplLanguageSchema.safeParse('TypeScript').success).toBe(true);
  });

  it('accepts Python', () => {
    expect(McpImplLanguageSchema.safeParse('Python').success).toBe(true);
  });

  it('rejects other languages', () => {
    expect(McpImplLanguageSchema.safeParse('Go').success).toBe(false);
  });
});

describe('CustomJwtAuthorizerConfigSchema', () => {
  const validConfig = {
    discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/pool123/.well-known/openid-configuration',
    allowedAudience: ['client-id-1'],
    allowedClients: ['client-id-1'],
  };

  it('accepts valid config', () => {
    expect(CustomJwtAuthorizerConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('rejects discovery URL without OIDC suffix', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...validConfig,
      discoveryUrl: 'https://example.com/auth',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL discovery URL', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...validConfig,
      discoveryUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty allowedClients', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...validConfig,
      allowedClients: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty allowedAudience (no audience validation)', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...validConfig,
      allowedAudience: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('ToolImplementationBindingSchema', () => {
  it('accepts valid Python binding', () => {
    const result = ToolImplementationBindingSchema.safeParse({
      language: 'Python',
      path: 'tools/my_tool',
      handler: 'handler.main',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid TypeScript binding', () => {
    const result = ToolImplementationBindingSchema.safeParse({
      language: 'TypeScript',
      path: 'tools/my-tool',
      handler: 'index.handler',
    });
    expect(result.success).toBe(true);
  });

  it('rejects extra fields (strict)', () => {
    const result = ToolImplementationBindingSchema.safeParse({
      language: 'Python',
      path: 'tools/my_tool',
      handler: 'handler.main',
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid language', () => {
    const result = ToolImplementationBindingSchema.safeParse({
      language: 'Go',
      path: 'tools/my_tool',
      handler: 'main',
    });
    expect(result.success).toBe(false);
  });
});

describe('ToolComputeConfigSchema (discriminated union)', () => {
  it('accepts valid Lambda compute with TypeScript', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'TypeScript', path: 'tools/my-tool', handler: 'index.handler' },
      nodeVersion: 'NODE_20',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid Lambda compute with Python', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'Python', path: 'tools/my-tool', handler: 'handler.main' },
      pythonVersion: 'PYTHON_3_12',
    });
    expect(result.success).toBe(true);
  });

  it('rejects TypeScript Lambda without nodeVersion', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'TypeScript', path: 'tools/my-tool', handler: 'index.handler' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Python Lambda without pythonVersion', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'Python', path: 'tools/my-tool', handler: 'handler.main' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid AgentCoreRuntime compute (Python only)', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'AgentCoreRuntime',
      implementation: { language: 'Python', path: 'tools/my-tool', handler: 'handler.main' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects AgentCoreRuntime with TypeScript', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'AgentCoreRuntime',
      implementation: { language: 'TypeScript', path: 'tools/my-tool', handler: 'index.handler' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts Lambda with optional timeout and memorySize', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'Python', path: 'tools', handler: 'h' },
      pythonVersion: 'PYTHON_3_12',
      timeout: 30,
      memorySize: 256,
    });
    expect(result.success).toBe(true);
  });

  it('rejects Lambda timeout exceeding 900', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'Python', path: 'tools', handler: 'h' },
      pythonVersion: 'PYTHON_3_12',
      timeout: 901,
    });
    expect(result.success).toBe(false);
  });

  it('rejects Lambda memorySize below 128', () => {
    const result = ToolComputeConfigSchema.safeParse({
      host: 'Lambda',
      implementation: { language: 'Python', path: 'tools', handler: 'h' },
      pythonVersion: 'PYTHON_3_12',
      memorySize: 64,
    });
    expect(result.success).toBe(false);
  });
});

describe('RuntimeConfigSchema', () => {
  const validRuntime = {
    artifact: 'CodeZip',
    pythonVersion: 'PYTHON_3_12',
    name: 'MyRuntime',
    entrypoint: 'main.py:handler',
    codeLocation: './tools/runtime',
  };

  it('accepts valid runtime config', () => {
    expect(RuntimeConfigSchema.safeParse(validRuntime).success).toBe(true);
  });

  it('defaults networkMode to PUBLIC', () => {
    const result = RuntimeConfigSchema.safeParse(validRuntime);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.networkMode).toBe('PUBLIC');
    }
  });

  it('accepts explicit VPC networkMode', () => {
    const result = RuntimeConfigSchema.safeParse({ ...validRuntime, networkMode: 'VPC' });
    expect(result.success).toBe(true);
  });

  it('rejects extra fields (strict)', () => {
    const result = RuntimeConfigSchema.safeParse({ ...validRuntime, extra: 'not allowed' });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreGatewayTargetSchema', () => {
  const validToolDef = {
    name: 'myTool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const },
  };

  it('accepts valid target', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty toolDefinitions', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts target with compute config', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('GatewayExceptionLevelSchema', () => {
  it('accepts NONE', () => {
    expect(GatewayExceptionLevelSchema.safeParse('NONE').success).toBe(true);
  });

  it('accepts DEBUG', () => {
    expect(GatewayExceptionLevelSchema.safeParse('DEBUG').success).toBe(true);
  });

  it('rejects invalid level', () => {
    expect(GatewayExceptionLevelSchema.safeParse('VERBOSE').success).toBe(false);
  });
});

describe('AgentCoreGatewaySchema', () => {
  const validToolDef = {
    name: 'myTool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const },
  };

  const validGateway = {
    name: 'my-gateway',
    targets: [
      {
        name: 'target1',
        targetType: 'lambda',
        toolDefinitions: [validToolDef],
        compute: {
          host: 'Lambda',
          implementation: { language: 'Python', path: 'tools', handler: 'h' },
          pythonVersion: 'PYTHON_3_12',
        },
      },
    ],
  };

  it('accepts valid gateway with default NONE auth', () => {
    const result = AgentCoreGatewaySchema.safeParse(validGateway);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authorizerType).toBe('NONE');
    }
  });

  it('accepts gateway with CUSTOM_JWT and valid config', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud'],
          allowedClients: ['client'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects CUSTOM_JWT without authorizer configuration', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      authorizerType: 'CUSTOM_JWT',
    });
    expect(result.success).toBe(false);
  });

  it('rejects CUSTOM_JWT with empty authorizer configuration', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {},
    });
    expect(result.success).toBe(false);
  });

  it('defaults enableSemanticSearch to true when omitted', () => {
    const result = AgentCoreGatewaySchema.safeParse(validGateway);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableSemanticSearch).toBe(true);
    }
  });

  it('accepts explicit enableSemanticSearch true', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      enableSemanticSearch: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableSemanticSearch).toBe(true);
    }
  });

  it('accepts explicit enableSemanticSearch false', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      enableSemanticSearch: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableSemanticSearch).toBe(false);
    }
  });

  it('rejects non-boolean enableSemanticSearch', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      enableSemanticSearch: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('defaults exceptionLevel to NONE when omitted', () => {
    const result = AgentCoreGatewaySchema.safeParse(validGateway);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exceptionLevel).toBe('NONE');
    }
  });

  it('accepts explicit exceptionLevel DEBUG', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      exceptionLevel: 'DEBUG',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exceptionLevel).toBe('DEBUG');
    }
  });

  it('rejects invalid exceptionLevel', () => {
    const result = AgentCoreGatewaySchema.safeParse({
      ...validGateway,
      exceptionLevel: 'VERBOSE',
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreMcpRuntimeToolSchema', () => {
  const validTool = {
    name: 'my-tool',
    toolDefinition: {
      name: 'myTool',
      description: 'A tool',
      inputSchema: { type: 'object' as const },
    },
    compute: {
      host: 'AgentCoreRuntime',
      implementation: { language: 'Python', path: 'tools/my-tool', handler: 'handler.main' },
    },
  };

  it('accepts valid MCP runtime tool', () => {
    expect(AgentCoreMcpRuntimeToolSchema.safeParse(validTool).success).toBe(true);
  });

  it('accepts tool with bindings', () => {
    const result = AgentCoreMcpRuntimeToolSchema.safeParse({
      ...validTool,
      bindings: [{ agentName: 'Agent1', envVarName: 'TOOL_ARN' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('ApiGatewayConfigSchema', () => {
  it('accepts valid config', () => {
    const result = ApiGatewayConfigSchema.safeParse({
      restApiId: 'abc123',
      stage: 'prod',
      apiGatewayToolConfiguration: {
        toolFilters: [{ filterPath: '/pets/*', methods: ['GET', 'POST'] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing restApiId', () => {
    const result = ApiGatewayConfigSchema.safeParse({
      stage: 'prod',
      apiGatewayToolConfiguration: {
        toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty toolFilters', () => {
    const result = ApiGatewayConfigSchema.safeParse({
      restApiId: 'abc123',
      stage: 'prod',
      apiGatewayToolConfiguration: {
        toolFilters: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreGatewayTargetSchema with apiGateway', () => {
  it('accepts valid apiGateway target', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-api',
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: 'abc123',
        stage: 'prod',
        apiGatewayToolConfiguration: {
          toolFilters: [{ filterPath: '/pets/*', methods: ['GET', 'POST'] }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects apiGateway without config', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-api',
      targetType: 'apiGateway',
    });
    expect(result.success).toBe(false);
  });

  it('rejects apiGateway with compute', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-api',
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: 'abc123',
        stage: 'prod',
        apiGatewayToolConfiguration: {
          toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'x', handler: 'x' },
        pythonVersion: '3.13',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects apiGateway with endpoint', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-api',
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: 'abc123',
        stage: 'prod',
        apiGatewayToolConfiguration: {
          toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
      endpoint: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('SchemaSourceSchema', () => {
  it('accepts inline source', () => {
    const result = SchemaSourceSchema.safeParse({ inline: { path: 'specs/petstore.json' } });
    expect(result.success).toBe(true);
  });

  it('accepts S3 source', () => {
    const result = SchemaSourceSchema.safeParse({ s3: { uri: 's3://bucket/key.json' } });
    expect(result.success).toBe(true);
  });

  it('accepts S3 source with bucketOwnerAccountId', () => {
    const result = SchemaSourceSchema.safeParse({
      s3: { uri: 's3://bucket/key.json', bucketOwnerAccountId: '123456789012' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects S3 source without s3:// prefix', () => {
    const result = SchemaSourceSchema.safeParse({ s3: { uri: 'https://bucket/key.json' } });
    expect(result.success).toBe(false);
  });

  it('rejects empty inline path', () => {
    const result = SchemaSourceSchema.safeParse({ inline: { path: '' } });
    expect(result.success).toBe(false);
  });

  it('rejects object with both inline and s3', () => {
    const result = SchemaSourceSchema.safeParse({
      inline: { path: 'specs/petstore.json' },
      s3: { uri: 's3://bucket/key.json' },
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreGatewayTargetSchema with openApiSchema/smithyModel', () => {
  it('accepts openApiSchema with inline schemaSource and auth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts openApiSchema with S3 schemaSource and auth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { s3: { uri: 's3://my-bucket/specs/petstore.json' } },
      outboundAuth: { type: 'API_KEY', credentialName: 'my-key' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts openApiSchema with S3 schemaSource and bucketOwnerAccountId', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { s3: { uri: 's3://my-bucket/specs/petstore.json', bucketOwnerAccountId: '123456789012' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects openApiSchema without outbound auth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects smithyModel with outbound auth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-service',
      targetType: 'smithyModel',
      schemaSource: { inline: { path: 'models/service.json' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects openApiSchema without schemaSource', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
    });
    expect(result.success).toBe(false);
  });

  it('accepts smithyModel with inline schemaSource', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-service',
      targetType: 'smithyModel',
      schemaSource: { inline: { path: 'models/service.json' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects smithyModel without schemaSource', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-service',
      targetType: 'smithyModel',
    });
    expect(result.success).toBe(false);
  });

  it('rejects openApiSchema with compute', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects openApiSchema with endpoint', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
      endpoint: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('accepts openApiSchema with outbound auth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'petstore',
      targetType: 'openApiSchema',
      schemaSource: { inline: { path: 'specs/petstore.json' } },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-cred' },
    });
    expect(result.success).toBe(true);
  });
});

describe('LambdaFunctionArnConfigSchema', () => {
  it('accepts valid config', () => {
    const result = LambdaFunctionArnConfigSchema.safeParse({
      lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
      toolSchemaFile: './tools.json',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing lambdaArn', () => {
    const result = LambdaFunctionArnConfigSchema.safeParse({
      toolSchemaFile: './tools.json',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing toolSchemaFile', () => {
    const result = LambdaFunctionArnConfigSchema.safeParse({
      lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty lambdaArn', () => {
    const result = LambdaFunctionArnConfigSchema.safeParse({
      lambdaArn: '',
      toolSchemaFile: './tools.json',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = LambdaFunctionArnConfigSchema.safeParse({
      lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
      toolSchemaFile: './tools.json',
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreGatewayTargetSchema with lambdaFunctionArn', () => {
  it('accepts valid lambdaFunctionArn target', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing lambdaFunctionArn config', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with compute', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'x', handler: 'x' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with endpoint', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      endpoint: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with apiGateway config', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      apiGateway: {
        restApiId: 'abc123',
        stage: 'prod',
        apiGatewayToolConfiguration: {
          toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with outboundAuth', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      outboundAuth: { type: 'OAUTH' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with outboundAuth type NONE', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      outboundAuth: { type: 'NONE' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects lambdaFunctionArn with toolDefinitions', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-lambda',
      targetType: 'lambdaFunctionArn',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      toolDefinitions: [{ name: 'myTool', description: 'A tool', inputSchema: { type: 'object' as const } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects apiGateway target with lambdaFunctionArn config', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'my-api',
      targetType: 'apiGateway',
      lambdaFunctionArn: {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
      },
      apiGateway: {
        restApiId: 'abc123',
        stage: 'prod',
        apiGatewayToolConfiguration: {
          toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreGatewayTargetSchema with outbound auth', () => {
  const validToolDef = {
    name: 'myTool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const },
  };

  it('outboundAuth with type OAUTH but no credentialName fails', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
      outboundAuth: { type: 'OAUTH' },
    });
    expect(result.success).toBe(false);
  });

  it('outboundAuth with type NONE and no credentialName passes', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
      outboundAuth: { type: 'NONE' },
    });
    expect(result.success).toBe(true);
  });

  it('outboundAuth with type OAUTH and credentialName passes', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
      outboundAuth: { type: 'OAUTH', credentialName: 'my-oauth-cred' },
    });
    expect(result.success).toBe(true);
  });

  it('mcpServer target with endpoint and no compute passes', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'mcpServer',
      endpoint: 'https://example.com/mcp',
    });
    expect(result.success).toBe(true);
  });

  it('mcpServer target with compute and no endpoint passes', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'mcpServer',
      compute: {
        host: 'AgentCoreRuntime',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('mcpServer target with neither endpoint nor compute fails', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'mcpServer',
    });
    expect(result.success).toBe(false);
  });

  it('Lambda target without compute fails', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [validToolDef],
    });
    expect(result.success).toBe(false);
  });

  it('Lambda target without toolDefinitions fails', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      compute: {
        host: 'Lambda',
        implementation: { language: 'Python', path: 'tools', handler: 'h' },
        pythonVersion: 'PYTHON_3_12',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreMcpSpecSchema', () => {
  it('accepts valid MCP spec', () => {
    const validToolDef = {
      name: 'tool',
      description: 'A tool',
      inputSchema: { type: 'object' as const },
    };

    const result = AgentCoreMcpSpecSchema.safeParse({
      agentCoreGateways: [
        {
          name: 'gw1',
          targets: [
            {
              name: 't1',
              targetType: 'lambda',
              toolDefinitions: [validToolDef],
              compute: {
                host: 'Lambda',
                implementation: { language: 'Python', path: 'tools', handler: 'h' },
                pythonVersion: 'PYTHON_3_12',
              },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects extra fields (strict)', () => {
    const result = AgentCoreMcpSpecSchema.safeParse({
      agentCoreGateways: [],
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  it('spec with unassignedTargets array parses correctly', () => {
    const validToolDef = {
      name: 'tool',
      description: 'A tool',
      inputSchema: { type: 'object' as const },
    };

    const result = AgentCoreMcpSpecSchema.safeParse({
      agentCoreGateways: [],
      unassignedTargets: [
        {
          name: 'unassigned-target',
          targetType: 'lambda',
          toolDefinitions: [validToolDef],
          compute: {
            host: 'Lambda',
            implementation: { language: 'Python', path: 'tools', handler: 'h' },
            pythonVersion: 'PYTHON_3_12',
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('spec without unassignedTargets parses correctly', () => {
    const result = AgentCoreMcpSpecSchema.safeParse({
      agentCoreGateways: [],
    });
    expect(result.success).toBe(true);
  });
});
