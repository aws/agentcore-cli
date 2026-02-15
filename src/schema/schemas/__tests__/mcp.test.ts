import {
  AgentCoreGatewaySchema,
  AgentCoreGatewayTargetSchema,
  AgentCoreMcpRuntimeToolSchema,
  AgentCoreMcpSpecSchema,
  CustomJwtAuthorizerConfigSchema,
  GatewayAuthorizerTypeSchema,
  GatewayTargetTypeSchema,
  McpImplLanguageSchema,
  RuntimeConfigSchema,
  ToolComputeConfigSchema,
  ToolImplementationBindingSchema,
} from '../mcp.js';
import { describe, expect, it } from 'vitest';

describe('GatewayTargetTypeSchema', () => {
  it.each(['lambda', 'mcpServer', 'openApiSchema', 'smithyModel'])('accepts "%s"', type => {
    expect(GatewayTargetTypeSchema.safeParse(type).success).toBe(true);
  });

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

  it('accepts explicit PRIVATE networkMode', () => {
    const result = RuntimeConfigSchema.safeParse({ ...validRuntime, networkMode: 'PRIVATE' });
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
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty toolDefinitions', () => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: 'myTarget',
      targetType: 'lambda',
      toolDefinitions: [],
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
          targets: [{ name: 't1', targetType: 'lambda', toolDefinitions: [validToolDef] }],
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
});
