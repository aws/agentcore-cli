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
      type: 'AgentCoreMemory',
      name: 'TestMemory',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts memory with empty strategies (short-term only)', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
      name: 'ShortTermOnly',
      eventExpiryDuration: 7,
      strategies: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults strategies to empty array', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
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
      type: 'AgentCoreMemory',
      name: 'Test',
      eventExpiryDuration: 6,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects eventExpiryDuration above 365', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
      name: 'Test',
      eventExpiryDuration: 366,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts eventExpiryDuration boundary values (7 and 365)', () => {
    expect(
      MemorySchema.safeParse({
        type: 'AgentCoreMemory',
        name: 'Min',
        eventExpiryDuration: 7,
        strategies: [],
      }).success
    ).toBe(true);

    expect(
      MemorySchema.safeParse({
        type: 'AgentCoreMemory',
        name: 'Max',
        eventExpiryDuration: 365,
        strategies: [],
      }).success
    ).toBe(true);
  });

  it('rejects non-integer eventExpiryDuration', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
      name: 'Test',
      eventExpiryDuration: 30.5,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate strategy types', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }, { type: 'SEMANTIC' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts multiple different strategy types', () => {
    const result = MemorySchema.safeParse({
      type: 'AgentCoreMemory',
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }, { type: 'SUMMARIZATION' }, { type: 'USER_PREFERENCE' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type literal', () => {
    const result = MemorySchema.safeParse({
      type: 'InvalidType',
      name: 'Test',
      eventExpiryDuration: 30,
      strategies: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('CredentialNameSchema', () => {
  it('accepts valid credential names', () => {
    expect(CredentialNameSchema.safeParse('MyProjectGemini').success).toBe(true);
    expect(CredentialNameSchema.safeParse('api-key.v2').success).toBe(true);
    expect(CredentialNameSchema.safeParse('my_cred_123').success).toBe(true);
  });

  it('rejects names shorter than 3 characters', () => {
    expect(CredentialNameSchema.safeParse('ab').success).toBe(false);
    expect(CredentialNameSchema.safeParse('a').success).toBe(false);
  });

  it('accepts name with exactly 3 characters', () => {
    expect(CredentialNameSchema.safeParse('abc').success).toBe(true);
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
      type: 'ApiKeyCredentialProvider',
      name: 'MyCredential',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = CredentialSchema.safeParse({
      type: 'OAuthProvider',
      name: 'MyCredential',
    });
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
      expect(result.data.agents).toEqual([]);
      expect(result.data.memories).toEqual([]);
      expect(result.data.credentials).toEqual([]);
    }
  });

  it('accepts project with agents', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'MyAgent',
          build: 'CodeZip',
          entrypoint: 'main.py',
          codeLocation: './agents/my-agent',
          runtimeVersion: 'PYTHON_3_12',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate agent names', () => {
    const agent = {
      type: 'AgentCoreRuntime',
      name: 'MyAgent',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: './agents/my-agent',
      runtimeVersion: 'PYTHON_3_12',
    };
    const result = AgentCoreProjectSpecSchema.safeParse({
      ...minimalProject,
      agents: [agent, agent],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate agent name'))).toBe(true);
    }
  });

  it('rejects duplicate memory names', () => {
    const memory = {
      type: 'AgentCoreMemory',
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
      type: 'ApiKeyCredentialProvider',
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          entrypoint: 'main.py',
          codeLocation: './agents/agent1',
          runtimeVersion: 'PYTHON_3_12',
        },
        {
          type: 'AgentCoreRuntime',
          name: 'Agent2',
          build: 'Container',
          entrypoint: 'index.ts',
          codeLocation: './agents/agent2',
          runtimeVersion: 'NODE_20',
        },
      ],
      memories: [
        {
          type: 'AgentCoreMemory',
          name: 'Memory1',
          eventExpiryDuration: 30,
          strategies: [{ type: 'SEMANTIC' }],
        },
      ],
      credentials: [
        { type: 'ApiKeyCredentialProvider', name: 'Cred1' },
        { type: 'ApiKeyCredentialProvider', name: 'Cred2' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer version', () => {
    const result = AgentCoreProjectSpecSchema.safeParse({
      name: 'Test',
      version: 1.5,
    });
    expect(result.success).toBe(false);
  });
});
