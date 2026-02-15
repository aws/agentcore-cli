import { validateAgentSchema, validateProjectSchema } from '../zod.js';
import { describe, expect, it } from 'vitest';

describe('validateAgentSchema', () => {
  const validAgent = {
    type: 'AgentCoreRuntime',
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('returns validated data for valid input', () => {
    const result = validateAgentSchema(validAgent);
    expect(result.name).toBe('TestAgent');
    expect(result.build).toBe('CodeZip');
  });

  it('throws for invalid input', () => {
    expect(() => validateAgentSchema({})).toThrow('Invalid AgentEnvSpec');
  });

  it('includes field-level errors in message', () => {
    try {
      validateAgentSchema({ type: 'Invalid' });
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('Invalid AgentEnvSpec');
    }
  });

  it('throws for null input', () => {
    expect(() => validateAgentSchema(null)).toThrow();
  });
});

describe('validateProjectSchema', () => {
  const validProject = {
    name: 'TestProject',
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };

  it('returns validated data for valid input', () => {
    const result = validateProjectSchema(validProject);
    expect(result.name).toBe('TestProject');
    expect(result.version).toBe(1);
  });

  it('applies defaults for missing optional arrays', () => {
    const result = validateProjectSchema({ name: 'MyProject', version: 1 });
    expect(result.agents).toEqual([]);
    expect(result.memories).toEqual([]);
    expect(result.credentials).toEqual([]);
  });

  it('throws for invalid input', () => {
    expect(() => validateProjectSchema({})).toThrow('Invalid AgentCoreProjectSpec');
  });

  it('throws for duplicate agent names', () => {
    const agent = {
      type: 'AgentCoreRuntime',
      name: 'Same',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: '.',
      runtimeVersion: 'PYTHON_3_12',
    };
    expect(() =>
      validateProjectSchema({
        name: 'MyProject',
        version: 1,
        agents: [agent, agent],
      })
    ).toThrow('Invalid AgentCoreProjectSpec');
  });
});
