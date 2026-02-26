import {
  AgentEnvSpecSchema,
  AgentNameSchema,
  BuildTypeSchema,
  EntrypointSchema,
  EnvVarNameSchema,
  EnvVarSchema,
  GatewayNameSchema,
  InstrumentationSchema,
} from '../agent-env.js';
import { describe, expect, it } from 'vitest';

describe('AgentNameSchema', () => {
  it.each(['Agent1', 'myAgent', 'A', 'agent_with_underscores', 'a' + '0'.repeat(47)])(
    'accepts valid name "%s"',
    name => {
      expect(AgentNameSchema.safeParse(name).success).toBe(true);
    }
  );

  it('rejects empty string', () => {
    expect(AgentNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with digit', () => {
    expect(AgentNameSchema.safeParse('1Agent').success).toBe(false);
  });

  it('rejects name with hyphens', () => {
    expect(AgentNameSchema.safeParse('my-agent').success).toBe(false);
  });

  it('rejects name exceeding 48 chars', () => {
    const name = 'A' + 'b'.repeat(48);
    expect(name).toHaveLength(49);
    expect(AgentNameSchema.safeParse(name).success).toBe(false);
  });

  it('accepts 48-char name (max)', () => {
    const name = 'A' + 'b'.repeat(47);
    expect(name).toHaveLength(48);
    expect(AgentNameSchema.safeParse(name).success).toBe(true);
  });
});

describe('EnvVarNameSchema', () => {
  it.each(['MY_VAR', '_private', 'UPPER123', 'a', '_'])('accepts valid env var name "%s"', name => {
    expect(EnvVarNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects name starting with digit', () => {
    expect(EnvVarNameSchema.safeParse('1VAR').success).toBe(false);
  });

  it('rejects name with hyphens', () => {
    expect(EnvVarNameSchema.safeParse('MY-VAR').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(EnvVarNameSchema.safeParse('').success).toBe(false);
  });
});

describe('GatewayNameSchema', () => {
  it.each(['gateway1', 'my-gateway', 'MyGateway', 'a'])('accepts valid gateway name "%s"', name => {
    expect(GatewayNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(GatewayNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name with underscores', () => {
    expect(GatewayNameSchema.safeParse('my_gateway').success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    const name = 'a'.repeat(101);
    expect(GatewayNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('EntrypointSchema', () => {
  describe('Python entrypoints', () => {
    it('accepts simple Python file', () => {
      expect(EntrypointSchema.safeParse('main.py').success).toBe(true);
    });

    it('accepts Python file with handler', () => {
      expect(EntrypointSchema.safeParse('main.py:handler').success).toBe(true);
    });

    it('accepts nested Python path', () => {
      expect(EntrypointSchema.safeParse('src/handler.py:app').success).toBe(true);
    });
  });

  describe('TypeScript/JavaScript entrypoints', () => {
    it('accepts TypeScript file', () => {
      expect(EntrypointSchema.safeParse('index.ts').success).toBe(true);
    });

    it('accepts JavaScript file', () => {
      expect(EntrypointSchema.safeParse('main.js').success).toBe(true);
    });

    it('accepts nested path', () => {
      expect(EntrypointSchema.safeParse('src/index.ts').success).toBe(true);
    });
  });

  describe('invalid entrypoints', () => {
    it('rejects file without valid extension', () => {
      expect(EntrypointSchema.safeParse('main.rb').success).toBe(false);
    });

    it('rejects empty string', () => {
      expect(EntrypointSchema.safeParse('').success).toBe(false);
    });

    it('rejects handler with invalid characters', () => {
      expect(EntrypointSchema.safeParse('main.py:123').success).toBe(false);
    });
  });
});

describe('EnvVarSchema', () => {
  it('accepts valid env var', () => {
    const result = EnvVarSchema.safeParse({ name: 'MY_KEY', value: 'my-value' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid name', () => {
    const result = EnvVarSchema.safeParse({ name: '123', value: 'val' });
    expect(result.success).toBe(false);
  });

  it('accepts empty value string', () => {
    const result = EnvVarSchema.safeParse({ name: 'KEY', value: '' });
    expect(result.success).toBe(true);
  });
});

describe('BuildTypeSchema', () => {
  it('accepts CodeZip', () => {
    expect(BuildTypeSchema.safeParse('CodeZip').success).toBe(true);
  });

  it('accepts Container', () => {
    expect(BuildTypeSchema.safeParse('Container').success).toBe(true);
  });

  it('rejects invalid build type', () => {
    expect(BuildTypeSchema.safeParse('Docker').success).toBe(false);
    expect(BuildTypeSchema.safeParse('lambda').success).toBe(false);
  });
});

describe('InstrumentationSchema', () => {
  it('accepts explicit enableOtel true', () => {
    const result = InstrumentationSchema.safeParse({ enableOtel: true });
    expect(result.success).toBe(true);
  });

  it('accepts explicit enableOtel false', () => {
    const result = InstrumentationSchema.safeParse({ enableOtel: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableOtel).toBe(false);
    }
  });

  it('defaults enableOtel to true', () => {
    const result = InstrumentationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableOtel).toBe(true);
    }
  });
});

describe('AgentEnvSpecSchema', () => {
  const validPythonAgent = {
    type: 'AgentCoreRuntime',
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
  };

  const validNodeAgent = {
    type: 'AgentCoreRuntime',
    name: 'NodeAgent',
    build: 'CodeZip',
    entrypoint: 'index.ts',
    codeLocation: './agents/node',
    runtimeVersion: 'NODE_20',
  };

  it('accepts valid Python agent', () => {
    expect(AgentEnvSpecSchema.safeParse(validPythonAgent).success).toBe(true);
  });

  it('accepts valid Node agent', () => {
    expect(AgentEnvSpecSchema.safeParse(validNodeAgent).success).toBe(true);
  });

  it('accepts agent with all Python runtime versions', () => {
    for (const version of ['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13']) {
      const result = AgentEnvSpecSchema.safeParse({ ...validPythonAgent, runtimeVersion: version });
      expect(result.success, `Should accept ${version}`).toBe(true);
    }
  });

  it('accepts agent with all Node runtime versions', () => {
    for (const version of ['NODE_18', 'NODE_20', 'NODE_22']) {
      const result = AgentEnvSpecSchema.safeParse({ ...validNodeAgent, runtimeVersion: version });
      expect(result.success, `Should accept ${version}`).toBe(true);
    }
  });

  it('rejects invalid runtime version', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, runtimeVersion: 'PYTHON_3_9' }).success).toBe(false);
    expect(AgentEnvSpecSchema.safeParse({ ...validNodeAgent, runtimeVersion: 'NODE_16' }).success).toBe(false);
  });

  it('accepts agent with optional env vars', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validPythonAgent,
      envVars: [{ name: 'API_KEY', value: 'secret' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent with network mode', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'PUBLIC' }).success).toBe(true);
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'PRIVATE' }).success).toBe(true);
  });

  it('rejects invalid network mode', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'VPC' }).success).toBe(false);
  });

  it('accepts agent with instrumentation config', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validPythonAgent,
      instrumentation: { enableOtel: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type literal', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, type: 'Lambda' }).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(AgentEnvSpecSchema.safeParse({ type: 'AgentCoreRuntime' }).success).toBe(false);
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, name: undefined }).success).toBe(false);
  });
});
