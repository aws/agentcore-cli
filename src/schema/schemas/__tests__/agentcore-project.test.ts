import {
  AgentCoreProjectSpecSchema,
  CredentialNameSchema,
  CredentialSchema,
  HarnessRegistryEntrySchema,
  MemoryNameSchema,
  MemorySchema,
  ProjectNameSchema,
} from '../agentcore-project.js';
import { describe, expect, it } from 'vitest';

describe('ProjectNameSchema', () => {
  it('accepts valid names', () => {
    expect(ProjectNameSchema.safeParse('A').success).toBe(true);
    expect(ProjectNameSchema.safeParse('MyProject').success).toBe(true);
    expect(ProjectNameSchema.safeParse('a1b2c3').success).toBe(true);
  });

  it('enforces 23-char boundary', () => {
    expect(ProjectNameSchema.safeParse('A' + 'b'.repeat(22)).success).toBe(true);
    expect(ProjectNameSchema.safeParse('A' + 'b'.repeat(23)).success).toBe(false);
  });

  it('rejects invalid formats', () => {
    expect(ProjectNameSchema.safeParse('').success).toBe(false);
    expect(ProjectNameSchema.safeParse('1project').success).toBe(false);
    expect(ProjectNameSchema.safeParse('my_project').success).toBe(false);
    expect(ProjectNameSchema.safeParse('my-project').success).toBe(false);
    expect(ProjectNameSchema.safeParse('my project').success).toBe(false);
    expect(ProjectNameSchema.safeParse('my.project').success).toBe(false);
  });

  it('rejects reserved names (case-insensitive)', () => {
    expect(ProjectNameSchema.safeParse('anthropic').success).toBe(false);
    expect(ProjectNameSchema.safeParse('Anthropic').success).toBe(false);
    expect(ProjectNameSchema.safeParse('openai').success).toBe(false);
    expect(ProjectNameSchema.safeParse('MyAgent').success).toBe(true);
  });
});

describe('MemoryNameSchema', () => {
  it('accepts valid names', () => {
    expect(MemoryNameSchema.safeParse('myMemory').success).toBe(true);
    expect(MemoryNameSchema.safeParse('Memory1').success).toBe(true);
    expect(MemoryNameSchema.safeParse('my_memory_store').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(MemoryNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with digit', () => {
    expect(MemoryNameSchema.safeParse('1memory').success).toBe(false);
  });

  it('rejects name with hyphens', () => {
    expect(MemoryNameSchema.safeParse('my-memory').success).toBe(false);
  });

  it('accepts 48-character name (max)', () => {
    const name = 'A' + 'b'.repeat(47);
    expect(name).toHaveLength(48);
    expect(MemoryNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects 49-character name', () => {
    const name = 'A' + 'b'.repeat(48);
    expect(name).toHaveLength(49);
    expect(MemoryNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('MemorySchema', () => {
  it('accepts valid memory with strategies', () => {
    const result = MemorySchema.safeParse({
      name: 'TestMemory',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts memory with empty strategies (short-term only)', () => {
    const result = MemorySchema.safeParse({
      name: 'ShortTermOnly',
      eventExpiryDuration: 7,
      strategies: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults strategies to empty array', () => {
    const result = MemorySchema.safeParse({
      name: 'NoStrategies',
      eventExpiryDuration: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strategies).toEqual([]);
    }
  });

  it('rejects eventExpiryDuration below 3', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 2,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects eventExpiryDuration above 365', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 366,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts eventExpiryDuration boundary values (3 and 365)', () => {
    expect(
      MemorySchema.safeParse({
        name: 'Min',
        eventExpiryDuration: 3,
        strategies: [],
      }).success
    ).toBe(true);

    expect(
      MemorySchema.safeParse({
        name: 'Max',
        eventExpiryDuration: 365,
        strategies: [],
      }).success
    ).toBe(true);
  });

  it('rejects non-integer eventExpiryDuration', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30.5,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate strategy types', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }, { type: 'SEMANTIC' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts multiple different strategy types', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }, { type: 'SUMMARIZATION' }, { type: 'USER_PREFERENCE' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts memory with streamDeliveryResources', () => {
    const result = MemorySchema.safeParse({
      name: 'StreamMemory',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }],
      streamDeliveryResources: {
        resources: [
          {
            kinesis: {
              dataStreamArn: 'arn:aws:kinesis:us-west-2:123456789012:stream/test',
              contentConfigurations: [{ type: 'MEMORY_RECORDS', level: 'FULL_CONTENT' }],
            },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts METADATA_ONLY content level', () => {
    const result = MemorySchema.safeParse({
      name: 'MetadataStream',
      eventExpiryDuration: 30,
      strategies: [],
      streamDeliveryResources: {
        resources: [
          {
            kinesis: {
              dataStreamArn: 'arn:aws:kinesis:us-west-2:123456789012:stream/test',
              contentConfigurations: [{ type: 'MEMORY_RECORDS', level: 'METADATA_ONLY' }],
            },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts memory without streamDeliveryResources', () => {
    const result = MemorySchema.safeParse({
      name: 'NoStream',
      eventExpiryDuration: 30,
      strategies: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.streamDeliveryResources).toBeUndefined();
  });

  it('rejects streamDeliveryResources with empty resources array', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [],
      streamDeliveryResources: { resources: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects streamDeliveryResources with empty contentConfigurations', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [],
      streamDeliveryResources: {
        resources: [
          {
            kinesis: { dataStreamArn: 'arn:aws:kinesis:us-west-2:123456789012:stream/test', contentConfigurations: [] },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects streamDeliveryResources with empty dataStreamArn', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [],
      streamDeliveryResources: {
        resources: [
          {
            kinesis: { dataStreamArn: '', contentConfigurations: [{ type: 'MEMORY_RECORDS', level: 'FULL_CONTENT' }] },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid content level in streamDeliveryResources', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [],
      streamDeliveryResources: {
        resources: [
          {
            kinesis: {
              dataStreamArn: 'arn:test',
              contentConfigurations: [{ type: 'MEMORY_RECORDS', level: 'INVALID' }],
            },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('CredentialNameSchema', () => {
  it('accepts valid credential names', () => {
    expect(CredentialNameSchema.safeParse('MyProjectGemini').success).toBe(true);
    expect(CredentialNameSchema.safeParse('api-key-v2').success).toBe(true);
    expect(CredentialNameSchema.safeParse('my_cred_123').success).toBe(true);
  });

  it('accepts single character name (min 1)', () => {
    expect(CredentialNameSchema.safeParse('a').success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(CredentialNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names longer than 128 characters', () => {
    expect(CredentialNameSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(CredentialNameSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects names with dots', () => {
    expect(CredentialNameSchema.safeParse('api-key.v2').success).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(CredentialNameSchema.safeParse('my credential').success).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(CredentialNameSchema.safeParse('my@cred').success).toBe(false);
    expect(CredentialNameSchema.safeParse('my/cred').success).toBe(false);
  });
});

describe('CredentialSchema', () => {
  it('accepts valid credential', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'ApiKeyCredentialProvider',
      name: 'MyCredential',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'OAuthProvider',
      name: 'MyCredential',
    });
    expect(result.success).toBe(false);
  });

  it('ApiKeyCredentialProvider with name passes', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'ApiKeyCredentialProvider',
      name: 'MyApiKey',
    });
    expect(result.success).toBe(true);
  });

  it('OAuthCredentialProvider with name and discoveryUrl passes', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'OAuthCredentialProvider',
      name: 'MyOAuth',
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    });
    expect(result.success).toBe(true);
  });

  it('OAuthCredentialProvider with scopes omitted passes', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'OAuthCredentialProvider',
      name: 'MyOAuth',
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    });
    expect(result.success).toBe(true);
  });

  it('OAuthCredentialProvider without discoveryUrl succeeds (optional for imported providers)', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'OAuthCredentialProvider',
      name: 'MyOAuth',
    });
    expect(result.success).toBe(true);
  });

  it('invalid type fails discriminated union', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'InvalidCredentialType',
      name: 'MyCred',
    });
    expect(result.success).toBe(false);
  });

  it('vendor defaults to CustomOauth2', () => {
    const result = CredentialSchema.safeParse({
      authorizerType: 'OAuthCredentialProvider',
      name: 'MyOAuth',
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.authorizerType === 'OAuthCredentialProvider') {
      expect(result.data.vendor).toBe('CustomOauth2');
    }
  });
});

describe('HarnessRegistryEntrySchema', () => {
  it('accepts valid entry', () => {
    const result = HarnessRegistryEntrySchema.safeParse({ name: 'myHarness', path: './harnesses/myHarness' });
    expect(result.success).toBe(true);
  });

  it('rejects name starting with digit', () => {
    const result = HarnessRegistryEntrySchema.safeParse({ name: '1harness', path: './harnesses/1harness' });
    expect(result.success).toBe(false);
  });
});

describe('AgentCoreProjectSpecSchema', () => {
  const minimalProject = {
    name: 'TestProject',
    version: 1,
  };

  it('accepts minimal project spec', () => {
    const result = AgentCoreProjectSpecSchema.safeParse(minimalProject);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes).toEqual([]);
      expect(result.data.memories).toEqual([]);
      expect(result.data.credentials).toEqual([]);
    }
  });

  it('accepts project with agents', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      runtimes: [
        {
          name: 'MyAgent',
          build: 'CodeZip',
          entrypoint: 'main.py',
          codeLocation: './agents/my-agent',
          runtimeVersion: 'PYTHON_3_12',
          protocol: 'HTTP',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate agent names', () => {
    const agent = {
      name: 'MyAgent',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: './agents/my-agent',
      runtimeVersion: 'PYTHON_3_12',
      protocol: 'HTTP',
    };
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      runtimes: [agent, agent],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate agent name'))).toBe(true);
    }
  });

  it('rejects duplicate memory names', () => {
    const memory = {
      name: 'SharedMemory',
      eventExpiryDuration: 30,
      strategies: [],
    };
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      memories: [memory, memory],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate memory name'))).toBe(true);
    }
  });

  it('rejects duplicate credential names', () => {
    const cred = {
      authorizerType: 'ApiKeyCredentialProvider',
      name: 'MyCred',
    };
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      credentials: [cred, cred],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate credential name'))).toBe(true);
    }
  });

  it('accepts project with all resource types', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      name: 'FullProject',
      version: 1,
      runtimes: [
        {
          name: 'Agent1',
          build: 'CodeZip',
          entrypoint: 'main.py',
          codeLocation: './agents/agent1',
          runtimeVersion: 'PYTHON_3_12',
          protocol: 'HTTP',
        },
        {
          name: 'Agent2',
          build: 'Container',
          entrypoint: 'index.ts',
          codeLocation: './agents/agent2',
          runtimeVersion: 'NODE_20',
          protocol: 'HTTP',
        },
      ],
      memories: [
        {
          name: 'Memory1',
          eventExpiryDuration: 30,
          strategies: [{ type: 'SEMANTIC' }],
        },
      ],
      credentials: [
        { authorizerType: 'ApiKeyCredentialProvider', name: 'Cred1' },
        { authorizerType: 'ApiKeyCredentialProvider', name: 'Cred2' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults managedBy to CDK when omitted', () => {
    const result = AgentCoreProjectSpecSchema.safeParse(minimalProject);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.managedBy).toBe('CDK');
    }
  });

  it('accepts explicit managedBy: CDK', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({ ...minimalProject, managedBy: 'CDK' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid managedBy value', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({ ...minimalProject, managedBy: 'Terraform' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer version', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      name: 'Test',
      version: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts project with harnesses array', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      harnesses: [{ name: 'myHarness', path: './harnesses/myHarness' }],
    });
    expect(result.success).toBe(true);
  });

  it('harnesses is undefined when not provided', () => {
    const result = AgentCoreProjectSpecSchema.safeParse(minimalProject);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harnesses).toEqual([]);
    }
  });

  it('rejects duplicate harness names', () => {
    const harness = { name: 'myHarness', path: './harnesses/myHarness' };
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      harnesses: [harness, harness],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate harness name'))).toBe(true);
    }
  });

  it('rejects harness with empty name', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      harnesses: [{ name: '', path: './harnesses/empty' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects harness with empty path', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      harnesses: [{ name: 'myHarness', path: '' }],
    });
    expect(result.success).toBe(false);
  });
});
