import {
  ModelProviderSchema,
  NetworkModeSchema,
  NodeRuntimeSchema,
  PythonRuntimeSchema,
  RESERVED_PROJECT_NAMES,
  RuntimeVersionSchema,
  SDKFrameworkSchema,
  getSupportedModelProviders,
  isModelProviderSupported,
  isReservedProjectName,
} from '../constants.js';
import { describe, expect, it } from 'vitest';

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

  it('accepts PRIVATE', () => {
    expect(NetworkModeSchema.safeParse('PRIVATE').success).toBe(true);
  });

  it('rejects other modes', () => {
    expect(NetworkModeSchema.safeParse('VPC').success).toBe(false);
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
