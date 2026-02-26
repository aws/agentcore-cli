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
    expect(result[0]!.type).toBe('AgentCoreMemory');
    expect(result[0]!.name).toBe('ProjMemory');
    expect(result[0]!.eventExpiryDuration).toBe(30);
    expect(result[0]!.strategies).toEqual([]);
  });

  it('returns memory with three strategies for "longAndShortTerm"', () => {
    const result = mapGenerateInputToMemories('longAndShortTerm', 'Proj');
    expect(result).toHaveLength(1);
    const strategies = result[0]!.strategies;
    expect(strategies).toHaveLength(3);
    const types = strategies.map(s => s.type);
    expect(types).toContain('SEMANTIC');
    expect(types).toContain('USER_PREFERENCE');
    expect(types).toContain('SUMMARIZATION');
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
    expect(result[0]!.type).toBe('ApiKeyCredentialProvider');
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
  it('creates AgentCoreRuntime agent spec', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.type).toBe('AgentCoreRuntime');
    expect(result.name).toBe('TestProject');
    expect(result.build).toBe('CodeZip');
    expect(result.entrypoint).toBe('main.py');
    expect(result.runtimeVersion).toBe('PYTHON_3_12');
    expect(result.networkMode).toBe('PUBLIC');
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
    expect(result.memories[0]!.strategies).toHaveLength(3);
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
  it('maps config with no memory and no identity', () => {
    const result = mapGenerateConfigToRenderConfig(baseConfig, []);
    expect(result.name).toBe('TestProject');
    expect(result.sdkFramework).toBe('Strands');
    expect(result.targetLanguage).toBe('Python');
    expect(result.modelProvider).toBe('Bedrock');
    expect(result.hasMemory).toBe(false);
    expect(result.hasIdentity).toBe(false);
    expect(result.memoryProviders).toEqual([]);
    expect(result.identityProviders).toEqual([]);
  });

  it('sets hasMemory true when memory is not "none"', () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'shortTerm' };
    const result = mapGenerateConfigToRenderConfig(config, []);
    expect(result.hasMemory).toBe(true);
  });

  it('sets hasIdentity true when identity providers exist', () => {
    const identityProviders = [{ name: 'ProjAnthropic', envVarName: 'AGENTCORE_CREDENTIAL_PROJANTHROPIC' }];
    const result = mapGenerateConfigToRenderConfig(baseConfig, identityProviders);
    expect(result.hasIdentity).toBe(true);
    expect(result.identityProviders).toEqual(identityProviders);
  });

  it('populates memoryProviders for shortTerm memory', () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'shortTerm' };
    const result = mapGenerateConfigToRenderConfig(config, []);
    expect(result.memoryProviders).toHaveLength(1);
    expect(result.memoryProviders[0]!.name).toBe('TestProjectMemory');
    expect(result.memoryProviders[0]!.envVarName).toBe('MEMORY_TESTPROJECTMEMORY_ID');
    expect(result.memoryProviders[0]!.strategies).toEqual([]);
  });

  it('populates memoryProviders with strategy types for longAndShortTerm', () => {
    const config: GenerateConfig = { ...baseConfig, memory: 'longAndShortTerm' };
    const result = mapGenerateConfigToRenderConfig(config, []);
    expect(result.memoryProviders[0]!.strategies).toEqual(['SEMANTIC', 'USER_PREFERENCE', 'SUMMARIZATION']);
  });
});
