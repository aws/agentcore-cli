import {
  AgentCoreProjectSpecSchema,
  CredentialNameSchema,
  CredentialSchema,
  MemoryNameSchema,
  MemorySchema,
  ProjectNameSchema,
} from '../agentcore-project.js';
import { describe, expect, it } from 'vitest';

describe('ProjectNameSchema', () => {
  describe('valid names', () => {
    it.each(['A', 'MyProject', 'test1', 'a1b2c3', 'ALLCAPS', 'abcdefghijklmnopqrstuvw'])('accepts "%s"', name => {
      expect(ProjectNameSchema.safeParse(name).success).toBe(true);
    });
  });

  describe('length validation', () => {
    it('rejects empty string', () => {
      expect(ProjectNameSchema.safeParse('').success).toBe(false);
    });

    it('accepts 1-character name', () => {
      expect(ProjectNameSchema.safeParse('A').success).toBe(true);
    });

    it('accepts 23-character name (max)', () => {
      const name = 'A' + 'b'.repeat(22);
      expect(name).toHaveLength(23);
      expect(ProjectNameSchema.safeParse(name).success).toBe(true);
    });

    it('rejects 24-character name', () => {
      const name = 'A' + 'b'.repeat(23);
      expect(name).toHaveLength(24);
      expect(ProjectNameSchema.safeParse(name).success).toBe(false);
    });
  });

  describe('format validation', () => {
    it('rejects name starting with a digit', () => {
      expect(ProjectNameSchema.safeParse('1project').success).toBe(false);
    });

    it('rejects name with underscores', () => {
      expect(ProjectNameSchema.safeParse('my_project').success).toBe(false);
    });

    it('rejects name with hyphens', () => {
      expect(ProjectNameSchema.safeParse('my-project').success).toBe(false);
    });

    it('rejects name with spaces', () => {
      expect(ProjectNameSchema.safeParse('my project').success).toBe(false);
    });

    it('rejects name with special characters', () => {
      expect(ProjectNameSchema.safeParse('my.project').success).toBe(false);
      expect(ProjectNameSchema.safeParse('my@project').success).toBe(false);
    });
  });

  describe('reserved name validation', () => {
    it.each(['anthropic', 'Anthropic', 'ANTHROPIC', 'openai', 'boto3', 'strands', 'test', 'pip', 'uv'])(
      'rejects reserved name "%s"',
      name => {
        // Some reserved names may also fail the regex (e.g., too long). We just check it doesn't pass.
        expect(ProjectNameSchema.safeParse(name).success).toBe(false);
      }
    );

    it('accepts non-reserved name', () => {
      expect(ProjectNameSchema.safeParse('MyAgent').success).toBe(true);
    });
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

  it('rejects eventExpiryDuration below 7', () => {
    const result = MemorySchema.safeParse({
      name: 'Test',
      eventExpiryDuration: 6,
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

  it('accepts eventExpiryDuration boundary values (7 and 365)', () => {
    expect(
      MemorySchema.safeParse({
        name: 'Min',
        eventExpiryDuration: 7,
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
});
