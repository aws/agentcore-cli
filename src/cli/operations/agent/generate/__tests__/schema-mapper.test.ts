import { computeManagedOAuthCredentialName } from '../../../../primitives/credential-utils.js';
import { mapByoConfigToAgent } from '../../../../tui/screens/agent/useAddAgent.js';
import type { GenerateConfig } from '../../../../tui/screens/generate/types.js';
import {
  mapGenerateConfigToAgent,
  mapGenerateConfigToRenderConfig,
  mapGenerateConfigToResources,
  mapGenerateInputToMemories,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
} from '../schema-mapper.js';
import { describe, expect, it } from 'vitest';

const baseConfig: GenerateConfig = {
  projectName: 'TestProject',
  buildType: 'CodeZip',
  protocol: 'HTTP',
  sdk: 'Strands',
  modelProvider: 'Bedrock',
  memory: 'none',
  language: 'Python',
};

describe('mapGenerateInputToMemories', () => {
  it('returns empty array for "none"', () => {
    expect(mapGenerateInputToMemories('none', 'Proj')).toEqual([]);
  });

  it('returns memory with no strategies for "shortTerm"', () => {
    const result = mapGenerateInputToMemories('shortTerm', 'Proj');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('ProjMemory');
    expect(result[0]!.eventExpiryDuration).toBe(30);
    expect(result[0]!.strategies).toEqual([]);
  });

  it('returns memory with four strategies for longAndShortTerm', () => {
    const result = mapGenerateInputToMemories('longAndShortTerm', 'Proj');
    expect(result).toHaveLength(1);
    const strategies = result[0]!.strategies;
    expect(strategies).toHaveLength(4);
    const types = strategies.map(s => s.type);
    expect(types).toContain('SEMANTIC');
    expect(types).toContain('USER_PREFERENCE');
    expect(types).toContain('SUMMARIZATION');
    expect(types).toContain('EPISODIC');
  });

  it('includes default namespaces for strategies', () => {
    const result = mapGenerateInputToMemories('longAndShortTerm', 'Proj');
    const semantic = result[0]!.strategies.find(s => s.type === 'SEMANTIC');
    expect(semantic?.namespaces).toEqual(['/users/{actorId}/facts']);
  });

  it('uses project name in memory name', () => {
    const result = mapGenerateInputToMemories('shortTerm', 'MyCustomProject');
    expect(result[0]!.name).toBe('MyCustomProjectMemory');
  });
});

describe('mapModelProviderToCredentials', () => {
  it('returns empty array for Bedrock', () => {
    expect(mapModelProviderToCredentials('Bedrock', 'Proj')).toEqual([]);
  });

  it('returns credential for Anthropic', () => {
    const result = mapModelProviderToCredentials('Anthropic', 'Proj');
    expect(result).toHaveLength(1);
    expect(result[0]!.authorizerType).toBe('ApiKeyCredentialProvider');
    expect(result[0]!.name).toBe('ProjAnthropic');
  });

  it('returns credential for OpenAI', () => {
    const result = mapModelProviderToCredentials('OpenAI', 'Proj');
    expect(result[0]!.name).toBe('ProjOpenAI');
  });

  it('returns credential for Gemini', () => {
    const result = mapModelProviderToCredentials('Gemini', 'Proj');
    expect(result[0]!.name).toBe('ProjGemini');
  });
});

describe('mapGenerateConfigToAgent', () => {
  it('creates agent spec', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.name).toBe('TestProject');
    expect(result.build).toBe('CodeZip');
    expect(result.entrypoint).toBe('main.py');
    expect(result.runtimeVersion).toBe('PYTHON_3_14');
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.protocol).toBe('HTTP');
  });

  it('uses projectName for codeLocation path', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.codeLocation).toBe('app/TestProject/');
  });
});

describe('mapGenerateConfigToResources', () => {
  it('returns agent, empty memories and credentials for Bedrock + no memory', () => {
    const result = mapGenerateConfigToResources(baseConfig);
    expect(result.agent.name).toBe('TestProject');
    expect(result.memories).toEqual([]);
    expect(result.credentials).toEqual([]);
  });

  it('includes memory when memory is selected', () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'shortTerm' };
    const result = mapGenerateConfigToResources(config);
    expect(result.memories).toHaveLength(1);
  });

  it('includes credential when non-Bedrock provider is selected', () => {
    const config: GenerateConfig = { ...baseConfig, modelProvider: 'Anthropic' };
    const result = mapGenerateConfigToResources(config);
    expect(result.credentials).toHaveLength(1);
  });

  it('includes both memory and credential when both configured', () => {
    const config: GenerateConfig = {
      ...baseConfig,
      memory: 'longAndShortTerm',
      modelProvider: 'OpenAI',
    };
    const result = mapGenerateConfigToResources(config);
    expect(result.memories).toHaveLength(1);
    expect(result.credentials).toHaveLength(1);
    expect(result.memories[0]!.strategies).toHaveLength(4);
  });
});

describe('mapModelProviderToIdentityProviders', () => {
  it('returns empty array for Bedrock', () => {
    expect(mapModelProviderToIdentityProviders('Bedrock', 'Proj')).toEqual([]);
  });

  it('returns identity provider for Anthropic', () => {
    const result = mapModelProviderToIdentityProviders('Anthropic', 'Proj');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('ProjAnthropic');
    expect(result[0]!.envVarName).toBe('AGENTCORE_CREDENTIAL_PROJANTHROPIC');
  });

  it('returns identity provider for OpenAI', () => {
    const result = mapModelProviderToIdentityProviders('OpenAI', 'Proj');
    expect(result[0]!.name).toBe('ProjOpenAI');
    expect(result[0]!.envVarName).toBe('AGENTCORE_CREDENTIAL_PROJOPENAI');
  });
});

describe('mapGenerateConfigToRenderConfig', () => {
  it('maps config with no memory and no identity', async () => {
    const result = await mapGenerateConfigToRenderConfig(baseConfig, []);
    expect(result.name).toBe('TestProject');
    expect(result.sdkFramework).toBe('Strands');
    expect(result.targetLanguage).toBe('Python');
    expect(result.modelProvider).toBe('Bedrock');
    expect(result.hasMemory).toBe(false);
    expect(result.hasIdentity).toBe(false);
    expect(result.hasGateway).toBe(false);
    expect(result.memoryProviders).toEqual([]);
    expect(result.identityProviders).toEqual([]);
    expect(result.gatewayProviders).toEqual([]);
  });

  it('sets hasMemory true when memory is not "none"', async () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'shortTerm' };
    const result = await mapGenerateConfigToRenderConfig(config, []);
    expect(result.hasMemory).toBe(true);
  });

  it('sets hasIdentity true when identity providers exist', async () => {
    const identityProviders = [{ name: 'ProjAnthropic', envVarName: 'AGENTCORE_CREDENTIAL_PROJANTHROPIC' }];
    const result = await mapGenerateConfigToRenderConfig(baseConfig, identityProviders);
    expect(result.hasIdentity).toBe(true);
    expect(result.identityProviders).toEqual(identityProviders);
  });

  it('populates memoryProviders for shortTerm memory', async () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'shortTerm' };
    const result = await mapGenerateConfigToRenderConfig(config, []);
    expect(result.memoryProviders).toHaveLength(1);
    expect(result.memoryProviders[0]!.name).toBe('TestProjectMemory');
    expect(result.memoryProviders[0]!.envVarName).toBe('MEMORY_TESTPROJECTMEMORY_ID');
    expect(result.memoryProviders[0]!.strategies).toEqual([]);
  });

  it('populates memoryProviders with strategy types for longAndShortTerm', async () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'longAndShortTerm' };
    const result = await mapGenerateConfigToRenderConfig(config, []);
    expect(result.memoryProviders[0]!.strategies).toEqual(['SEMANTIC', 'USER_PREFERENCE', 'SUMMARIZATION', 'EPISODIC']);
  });
});

describe('mapGenerateConfigToAgent protocol mode', () => {
  it('omits modelProvider and sets protocol for MCP', () => {
    const mcpConfig: GenerateConfig = {
      ...baseConfig,
      protocol: 'MCP',
    };
    const result = mapGenerateConfigToAgent(mcpConfig);
    expect(result.protocol).toBe('MCP');
    expect(result).not.toHaveProperty('modelProvider');
  });

  it('sets protocol to HTTP explicitly', () => {
    const httpConfig: GenerateConfig = {
      ...baseConfig,
      protocol: 'HTTP',
    };
    const result = mapGenerateConfigToAgent(httpConfig);
    expect(result.protocol).toBe('HTTP');
  });

  it('sets protocol for A2A', () => {
    const a2aConfig: GenerateConfig = {
      ...baseConfig,
      protocol: 'A2A',
    };
    const result = mapGenerateConfigToAgent(a2aConfig);
    expect(result.protocol).toBe('A2A');
  });
});

describe('gateway credential provider name mapping', () => {
  it('computeManagedOAuthCredentialName produces the correct suffix', () => {
    // Regression test: the managed credential name must use '-oauth' suffix.
    // GatewayPrimitive creates it, schema-mapper looks it up, AddGatewayScreen displays it.
    // All three now use computeManagedOAuthCredentialName to stay in sync.
    expect(computeManagedOAuthCredentialName('my-gateway')).toBe('my-gateway-oauth');
    expect(computeManagedOAuthCredentialName('test')).toBe('test-oauth');
  });
});

describe('mapGenerateConfigToAgent - VPC support', () => {
  const vpcBaseConfig = {
    projectName: 'TestAgent',
    buildType: 'CodeZip' as const,
    protocol: 'HTTP' as const,
    sdk: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    memory: 'none' as const,
    language: 'Python' as const,
  };

  it('defaults to PUBLIC network mode when networkMode is absent', () => {
    const result = mapGenerateConfigToAgent(vpcBaseConfig);
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('uses PUBLIC network mode when explicitly set', () => {
    const result = mapGenerateConfigToAgent({ ...vpcBaseConfig, networkMode: 'PUBLIC' });
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('produces networkConfig for VPC mode with subnets and security groups', () => {
    const result = mapGenerateConfigToAgent({
      ...vpcBaseConfig,
      networkMode: 'VPC',
      subnets: ['subnet-12345678', 'subnet-abcdef12'],
      securityGroups: ['sg-12345678'],
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toEqual({
      subnets: ['subnet-12345678', 'subnet-abcdef12'],
      securityGroups: ['sg-12345678'],
    });
  });

  it('does not produce networkConfig for VPC mode without subnets', () => {
    const result = mapGenerateConfigToAgent({
      ...vpcBaseConfig,
      networkMode: 'VPC',
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toBeUndefined();
  });
});

describe('mapByoConfigToAgent - requestHeaderAllowlist', () => {
  it('includes requestHeaderAllowlist when provided', () => {
    const config = {
      name: 'TestAgent',
      agentType: 'byo' as const,
      codeLocation: 'app/test/',
      entrypoint: 'main.py',
      language: 'Python' as const,
      buildType: 'CodeZip' as const,
      protocol: 'HTTP' as const,
      framework: 'Strands' as const,
      modelProvider: 'Bedrock' as const,
      pythonVersion: 'PYTHON_3_12' as const,
      memory: 'none' as const,
      requestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-H1', 'Authorization'],
    };
    const result = mapByoConfigToAgent(config);
    expect(result.requestHeaderAllowlist).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-H1', 'Authorization']);
  });

  it('omits requestHeaderAllowlist when not provided', () => {
    const config = {
      name: 'TestAgent',
      agentType: 'byo' as const,
      codeLocation: 'app/test/',
      entrypoint: 'main.py',
      language: 'Python' as const,
      buildType: 'CodeZip' as const,
      protocol: 'HTTP' as const,
      framework: 'Strands' as const,
      modelProvider: 'Bedrock' as const,
      pythonVersion: 'PYTHON_3_12' as const,
      memory: 'none' as const,
    };
    const result = mapByoConfigToAgent(config);
    expect(result.requestHeaderAllowlist).toBeUndefined();
  });
});

describe('mapGenerateConfigToAgent - requestHeaderAllowlist', () => {
  it('includes requestHeaderAllowlist when provided', () => {
    const config = {
      ...baseConfig,
      requestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-H1'],
    };
    const result = mapGenerateConfigToAgent(config);
    expect(result.requestHeaderAllowlist).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-H1']);
  });

  it('omits requestHeaderAllowlist when empty array', () => {
    const config = { ...baseConfig, requestHeaderAllowlist: [] as string[] };
    const result = mapGenerateConfigToAgent(config);
    expect(result.requestHeaderAllowlist).toBeUndefined();
  });

  it('omits requestHeaderAllowlist when undefined', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.requestHeaderAllowlist).toBeUndefined();
  });
});

describe('mapByoConfigToAgent - VPC support', () => {
  const baseByoConfig = {
    name: 'MyByo',
    agentType: 'byo' as const,
    codeLocation: 'app/MyByo/',
    entrypoint: 'main.py',
    language: 'Python' as const,
    buildType: 'CodeZip' as const,
    protocol: 'HTTP' as const,
    framework: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    pythonVersion: 'PYTHON_3_12' as const,
    memory: 'none' as const,
  };

  it('defaults to PUBLIC network mode when networkMode is undefined', () => {
    const result = mapByoConfigToAgent(baseByoConfig);
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('produces networkConfig for VPC mode with subnets and security groups', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'VPC',
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toEqual({
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
  });

  it('does not produce networkConfig for VPC mode without subnets', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'VPC',
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('does not produce networkConfig for PUBLIC mode even with subnets', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'PUBLIC',
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });
});

describe('mapGenerateConfigToAgent - lifecycleConfiguration', () => {
  it('includes lifecycleConfiguration when idleRuntimeSessionTimeout is set', () => {
    const result = mapGenerateConfigToAgent({ ...baseConfig, idleRuntimeSessionTimeout: 600 });
    expect(result.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 600 });
  });

  it('includes lifecycleConfiguration when maxLifetime is set', () => {
    const result = mapGenerateConfigToAgent({ ...baseConfig, maxLifetime: 14400 });
    expect(result.lifecycleConfiguration).toEqual({ maxLifetime: 14400 });
  });

  it('includes both fields when both are set', () => {
    const result = mapGenerateConfigToAgent({ ...baseConfig, idleRuntimeSessionTimeout: 300, maxLifetime: 7200 });
    expect(result.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 300, maxLifetime: 7200 });
  });

  it('omits lifecycleConfiguration when neither field is set', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.lifecycleConfiguration).toBeUndefined();
  });
});

describe('mapByoConfigToAgent - lifecycleConfiguration', () => {
  const baseByoConfig = {
    name: 'ByoAgent',
    agentType: 'byo' as const,
    codeLocation: 'app/ByoAgent/',
    entrypoint: 'main.py',
    language: 'Python' as const,
    buildType: 'CodeZip' as const,
    protocol: 'HTTP' as const,
    framework: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    pythonVersion: 'PYTHON_3_12' as const,
    memory: 'none' as const,
  };

  it('includes lifecycleConfiguration when idleRuntimeSessionTimeout is set', () => {
    const result = mapByoConfigToAgent({ ...baseByoConfig, idleRuntimeSessionTimeout: 900 });
    expect(result.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 900 });
  });

  it('includes lifecycleConfiguration when maxLifetime is set', () => {
    const result = mapByoConfigToAgent({ ...baseByoConfig, maxLifetime: 28800 });
    expect(result.lifecycleConfiguration).toEqual({ maxLifetime: 28800 });
  });

  it('includes both fields when both are set', () => {
    const result = mapByoConfigToAgent({ ...baseByoConfig, idleRuntimeSessionTimeout: 600, maxLifetime: 3600 });
    expect(result.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 600, maxLifetime: 3600 });
  });

  it('omits lifecycleConfiguration when neither field is set', () => {
    const result = mapByoConfigToAgent(baseByoConfig);
    expect(result.lifecycleConfiguration).toBeUndefined();
  });
});
