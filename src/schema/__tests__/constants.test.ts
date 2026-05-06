import {
  ModelProviderSchema,
  NetworkModeSchema,
  NodeRuntimeSchema,
  PROTOCOL_FRAMEWORK_MATRIX,
  PythonRuntimeSchema,
  RESERVED_PROJECT_NAMES,
  RuntimeVersionSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
  getSupportedFrameworksForProtocol,
  getSupportedModelProviders,
  isFrameworkSupportedForProtocol,
  isModelProviderSupported,
  isReservedProjectName,
  matchEnumValue,
} from '../constants.js';
import { describe, expect, it } from 'vitest';

describe('matchEnumValue', () => {
  it('returns canonical value for case-insensitive match', () => {
    expect(matchEnumValue(SDKFrameworkSchema, 'strands')).toBe('Strands');
    expect(matchEnumValue(SDKFrameworkSchema, 'STRANDS')).toBe('Strands');
    expect(matchEnumValue(SDKFrameworkSchema, 'Strands')).toBe('Strands');
    expect(matchEnumValue(ModelProviderSchema, 'bedrock')).toBe('Bedrock');
    expect(matchEnumValue(TargetLanguageSchema, 'python')).toBe('Python');
  });

  it('returns undefined for non-matching input', () => {
    expect(matchEnumValue(SDKFrameworkSchema, 'nonexistent')).toBeUndefined();
    expect(matchEnumValue(ModelProviderSchema, 'azure')).toBeUndefined();
  });

  it('handles multi-word enum values', () => {
    expect(matchEnumValue(SDKFrameworkSchema, 'langchain_langgraph')).toBe('LangChain_LangGraph');
    expect(matchEnumValue(SDKFrameworkSchema, 'openaiagents')).toBe('OpenAIAgents');
    expect(matchEnumValue(SDKFrameworkSchema, 'googleadk')).toBe('GoogleADK');
  });
});

describe('SDKFrameworkSchema', () => {
  it('accepts valid frameworks and rejects invalid', () => {
    expect(SDKFrameworkSchema.safeParse('Strands').success).toBe(true);
    expect(SDKFrameworkSchema.safeParse('OpenAIAgents').success).toBe(true);
    expect(SDKFrameworkSchema.safeParse('AutoGen').success).toBe(false);
    expect(SDKFrameworkSchema.safeParse('strands').success).toBe(false); // case-sensitive
  });
});

describe('ModelProviderSchema', () => {
  it('accepts valid providers and rejects invalid', () => {
    expect(ModelProviderSchema.safeParse('Bedrock').success).toBe(true);
    expect(ModelProviderSchema.safeParse('Anthropic').success).toBe(true);
    expect(ModelProviderSchema.safeParse('Azure').success).toBe(false);
  });
});

describe('RuntimeVersionSchemas', () => {
  it('accepts valid Python and Node versions', () => {
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_10').success).toBe(true);
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_14').success).toBe(true);
    expect(NodeRuntimeSchema.safeParse('NODE_18').success).toBe(true);
    expect(NodeRuntimeSchema.safeParse('NODE_22').success).toBe(true);
    expect(RuntimeVersionSchema.safeParse('PYTHON_3_12').success).toBe(true);
    expect(RuntimeVersionSchema.safeParse('NODE_20').success).toBe(true);
  });

  it('rejects invalid versions', () => {
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_9').success).toBe(false);
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_15').success).toBe(false);
    expect(NodeRuntimeSchema.safeParse('NODE_16').success).toBe(false);
    expect(NodeRuntimeSchema.safeParse('NODE_24').success).toBe(false);
    expect(RuntimeVersionSchema.safeParse('RUBY_3_0').success).toBe(false);
  });
});

describe('NetworkModeSchema', () => {
  it('accepts valid modes and rejects invalid', () => {
    expect(NetworkModeSchema.safeParse('PUBLIC').success).toBe(true);
    expect(NetworkModeSchema.safeParse('VPC').success).toBe(true);
    expect(NetworkModeSchema.safeParse('PRIVATE').success).toBe(false);
  });
});

describe('getSupportedModelProviders', () => {
  it('returns all 4 providers for Strands', () => {
    expect(getSupportedModelProviders('Strands')).toEqual(['Bedrock', 'Anthropic', 'OpenAI', 'Gemini']);
  });

  it('returns only Gemini for GoogleADK', () => {
    expect(getSupportedModelProviders('GoogleADK')).toEqual(['Gemini']);
  });

  it('returns only OpenAI for OpenAIAgents', () => {
    expect(getSupportedModelProviders('OpenAIAgents')).toEqual(['OpenAI']);
  });
});

describe('isModelProviderSupported', () => {
  it('returns true for supported combinations', () => {
    expect(isModelProviderSupported('Strands', 'Bedrock')).toBe(true);
    expect(isModelProviderSupported('GoogleADK', 'Gemini')).toBe(true);
    expect(isModelProviderSupported('OpenAIAgents', 'OpenAI')).toBe(true);
  });

  it('returns false for unsupported combinations', () => {
    expect(isModelProviderSupported('GoogleADK', 'Bedrock')).toBe(false);
    expect(isModelProviderSupported('OpenAIAgents', 'Anthropic')).toBe(false);
  });
});

describe('isReservedProjectName', () => {
  it('detects reserved names case-insensitively', () => {
    expect(isReservedProjectName('anthropic')).toBe(true);
    expect(isReservedProjectName('Anthropic')).toBe(true);
    expect(isReservedProjectName('ANTHROPIC')).toBe(true);
  });

  it('detects common reserved names', () => {
    expect(isReservedProjectName('boto3')).toBe(true);
    expect(isReservedProjectName('openai')).toBe(true);
    expect(isReservedProjectName('test')).toBe(true);
    expect(isReservedProjectName('pip')).toBe(true);
    expect(isReservedProjectName('build')).toBe(true);
  });

  it('returns false for non-reserved names', () => {
    expect(isReservedProjectName('MyProject')).toBe(false);
    expect(isReservedProjectName('AgentOne')).toBe(false);
  });

  it('RESERVED_PROJECT_NAMES is not empty', () => {
    expect(RESERVED_PROJECT_NAMES.length).toBeGreaterThan(0);
  });
});

describe('PROTOCOL_FRAMEWORK_MATRIX', () => {
  it('defines all protocol modes', () => {
    expect(Object.keys(PROTOCOL_FRAMEWORK_MATRIX)).toEqual(expect.arrayContaining(['HTTP', 'MCP', 'A2A', 'AGUI']));
    expect(Object.keys(PROTOCOL_FRAMEWORK_MATRIX)).toHaveLength(4);
  });

  it('HTTP supports all visible frameworks', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.HTTP).toEqual(
      expect.arrayContaining(['Strands', 'LangChain_LangGraph', 'GoogleADK', 'OpenAIAgents'])
    );
  });

  it('MCP returns empty frameworks array', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.MCP).toEqual([]);
  });

  it('A2A includes Strands and GoogleADK but not OpenAIAgents', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).toContain('Strands');
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).toContain('GoogleADK');
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).not.toContain('OpenAIAgents');
  });
});

describe('getSupportedFrameworksForProtocol', () => {
  it('returns all frameworks for HTTP', () => {
    const frameworks = getSupportedFrameworksForProtocol('HTTP');
    expect(frameworks).toContain('Strands');
    expect(frameworks.length).toBeGreaterThan(0);
  });

  it('returns empty array for MCP', () => {
    expect(getSupportedFrameworksForProtocol('MCP')).toEqual([]);
  });

  it('returns frameworks for A2A', () => {
    const frameworks = getSupportedFrameworksForProtocol('A2A');
    expect(frameworks).toContain('Strands');
    expect(frameworks.length).toBeGreaterThan(0);
  });
});

describe('isFrameworkSupportedForProtocol', () => {
  it('returns true for Strands + HTTP', () => {
    expect(isFrameworkSupportedForProtocol('HTTP', 'Strands')).toBe(true);
  });

  it('returns true for Strands + A2A', () => {
    expect(isFrameworkSupportedForProtocol('A2A', 'Strands')).toBe(true);
  });

  it('returns false for OpenAIAgents + A2A', () => {
    expect(isFrameworkSupportedForProtocol('A2A', 'OpenAIAgents')).toBe(false);
  });

  it('returns false for any framework + MCP', () => {
    expect(isFrameworkSupportedForProtocol('MCP', 'Strands')).toBe(false);
    expect(isFrameworkSupportedForProtocol('MCP', 'OpenAIAgents')).toBe(false);
  });
});
