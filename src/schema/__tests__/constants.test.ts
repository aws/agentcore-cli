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
  it.each(['Strands', 'LangChain_LangGraph', 'CrewAI', 'GoogleADK', 'OpenAIAgents'])('accepts "%s"', framework => {
    expect(SDKFrameworkSchema.safeParse(framework).success).toBe(true);
  });

  it('rejects invalid framework', () => {
    expect(SDKFrameworkSchema.safeParse('AutoGen').success).toBe(false);
    expect(SDKFrameworkSchema.safeParse('strands').success).toBe(false); // case-sensitive
  });
});

describe('ModelProviderSchema', () => {
  it.each(['Bedrock', 'Gemini', 'OpenAI', 'Anthropic'])('accepts "%s"', provider => {
    expect(ModelProviderSchema.safeParse(provider).success).toBe(true);
  });

  it('rejects invalid provider', () => {
    expect(ModelProviderSchema.safeParse('Azure').success).toBe(false);
  });
});

describe('PythonRuntimeSchema', () => {
  it.each(['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13'])('accepts "%s"', version => {
    expect(PythonRuntimeSchema.safeParse(version).success).toBe(true);
  });

  it('rejects unsupported versions', () => {
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_9').success).toBe(false);
    expect(PythonRuntimeSchema.safeParse('PYTHON_3_14').success).toBe(false);
  });
});

describe('NodeRuntimeSchema', () => {
  it.each(['NODE_18', 'NODE_20', 'NODE_22'])('accepts "%s"', version => {
    expect(NodeRuntimeSchema.safeParse(version).success).toBe(true);
  });

  it('rejects unsupported versions', () => {
    expect(NodeRuntimeSchema.safeParse('NODE_16').success).toBe(false);
    expect(NodeRuntimeSchema.safeParse('NODE_24').success).toBe(false);
  });
});

describe('RuntimeVersionSchema', () => {
  it('accepts Python versions', () => {
    expect(RuntimeVersionSchema.safeParse('PYTHON_3_12').success).toBe(true);
  });

  it('accepts Node versions', () => {
    expect(RuntimeVersionSchema.safeParse('NODE_20').success).toBe(true);
  });

  it('rejects invalid versions', () => {
    expect(RuntimeVersionSchema.safeParse('RUBY_3_0').success).toBe(false);
  });
});

describe('NetworkModeSchema', () => {
  it('accepts PUBLIC', () => {
    expect(NetworkModeSchema.safeParse('PUBLIC').success).toBe(true);
  });

  it('accepts VPC', () => {
    expect(NetworkModeSchema.safeParse('VPC').success).toBe(true);
  });

  it('rejects other modes', () => {
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
    expect(Object.keys(PROTOCOL_FRAMEWORK_MATRIX)).toEqual(expect.arrayContaining(['HTTP', 'MCP', 'A2A']));
    expect(Object.keys(PROTOCOL_FRAMEWORK_MATRIX)).toHaveLength(3);
  });

  it('HTTP supports all frameworks', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.HTTP).toEqual(
      expect.arrayContaining(['Strands', 'LangChain_LangGraph', 'CrewAI', 'GoogleADK', 'OpenAIAgents'])
    );
  });

  it('MCP returns empty frameworks array', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.MCP).toEqual([]);
  });

  it('A2A includes Strands and GoogleADK but not CrewAI or OpenAIAgents', () => {
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).toContain('Strands');
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).toContain('GoogleADK');
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).not.toContain('CrewAI');
    expect(PROTOCOL_FRAMEWORK_MATRIX.A2A).not.toContain('OpenAIAgents');
  });
});

describe('getSupportedFrameworksForProtocol', () => {
  it('returns all frameworks for HTTP', () => {
    const frameworks = getSupportedFrameworksForProtocol('HTTP');
    expect(frameworks).toContain('Strands');
    expect(frameworks).toContain('CrewAI');
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

  it('returns false for CrewAI + A2A', () => {
    expect(isFrameworkSupportedForProtocol('A2A', 'CrewAI')).toBe(false);
  });

  it('returns false for OpenAIAgents + A2A', () => {
    expect(isFrameworkSupportedForProtocol('A2A', 'OpenAIAgents')).toBe(false);
  });

  it('returns false for any framework + MCP', () => {
    expect(isFrameworkSupportedForProtocol('MCP', 'Strands')).toBe(false);
    expect(isFrameworkSupportedForProtocol('MCP', 'CrewAI')).toBe(false);
  });
});
