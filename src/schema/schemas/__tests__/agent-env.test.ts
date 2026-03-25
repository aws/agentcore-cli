import {
  AgentEnvSpecSchema,
  AgentNameSchema,
  BuildTypeSchema,
  EntrypointSchema,
  EnvVarNameSchema,
  EnvVarSchema,
  GatewayNameSchema,
  InstrumentationSchema,
  LifecycleConfigurationSchema,
  NetworkConfigSchema,
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
    protocol: 'HTTP',
  };

  const validNodeAgent = {
    type: 'AgentCoreRuntime',
    name: 'NodeAgent',
    build: 'CodeZip',
    entrypoint: 'index.ts',
    codeLocation: './agents/node',
    runtimeVersion: 'NODE_20',
    protocol: 'HTTP',
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

  it('accepts agent with PUBLIC network mode', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'PUBLIC' }).success).toBe(true);
  });

  it('accepts agent with VPC network mode and networkConfig', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validPythonAgent,
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects VPC network mode without networkConfig', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'VPC' });
    expect(result.success).toBe(false);
  });

  it('rejects networkConfig without VPC network mode', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validPythonAgent,
      networkMode: 'PUBLIC',
      networkConfig: {
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid network mode', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, networkMode: 'PRIVATE' }).success).toBe(false);
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

  describe('protocol', () => {
    it.each(['HTTP', 'MCP', 'A2A'])('accepts valid protocol "%s"', mode => {
      const result = AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: mode });
      expect(result.success, `Should accept protocol ${mode}`).toBe(true);
    });

    it('accepts agent without protocol (backwards compat)', () => {
      const { protocol: _protocol, ...agentWithoutProtocol } = { ...validPythonAgent, protocol: undefined };
      expect(AgentEnvSpecSchema.safeParse(agentWithoutProtocol).success).toBe(true);
    });

    it('rejects invalid protocol', () => {
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'GRPC' }).success).toBe(false);
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'websocket' }).success).toBe(false);
    });
  });
});

describe('NetworkConfigSchema', () => {
  it('accepts valid subnets and security groups', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['subnet-12345678', 'subnet-abcdef1234567890a'],
      securityGroups: ['sg-12345678'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid subnet format', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['invalid-subnet'],
      securityGroups: ['sg-12345678'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid security group format', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['subnet-12345678'],
      securityGroups: ['invalid-sg'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty subnets array', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: [],
      securityGroups: ['sg-12345678'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty security groups array', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['subnet-12345678'],
      securityGroups: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('LifecycleConfigurationSchema', () => {
  it('accepts empty object (both fields optional)', () => {
    expect(LifecycleConfigurationSchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid idleRuntimeSessionTimeout only', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 900 }).success).toBe(true);
  });

  it('accepts valid maxLifetime only', () => {
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 28800 }).success).toBe(true);
  });

  it('accepts both fields when idle <= maxLifetime', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 900, maxLifetime: 28800 }).success).toBe(
      true
    );
  });

  it('accepts both fields when idle === maxLifetime', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 3600, maxLifetime: 3600 }).success).toBe(
      true
    );
  });

  it('accepts minimum value (60)', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 60 }).success).toBe(true);
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 60 }).success).toBe(true);
  });

  it('accepts maximum value (28800)', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 28800 }).success).toBe(true);
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 28800 }).success).toBe(true);
  });

  it('rejects idle > maxLifetime', () => {
    const result = LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 10000, maxLifetime: 5000 });
    expect(result.success).toBe(false);
  });

  it('rejects value below minimum (59)', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 59 }).success).toBe(false);
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 59 }).success).toBe(false);
  });

  it('rejects value above maximum (28801)', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 28801 }).success).toBe(false);
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 28801 }).success).toBe(false);
  });

  it('rejects non-integer values', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: 900.5 }).success).toBe(false);
    expect(LifecycleConfigurationSchema.safeParse({ maxLifetime: 100.1 }).success).toBe(false);
  });

  it('rejects non-number values', () => {
    expect(LifecycleConfigurationSchema.safeParse({ idleRuntimeSessionTimeout: '900' }).success).toBe(false);
  });
});

describe('AgentEnvSpecSchema - lifecycleConfiguration', () => {
  const validAgent = {
    type: 'AgentCoreRuntime',
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: 'app/TestAgent/',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('accepts agent without lifecycleConfiguration', () => {
    expect(AgentEnvSpecSchema.safeParse(validAgent).success).toBe(true);
  });

  it('accepts agent with valid lifecycleConfiguration', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 7200 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent with only idleRuntimeSessionTimeout', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 600 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent with only maxLifetime', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      lifecycleConfiguration: { maxLifetime: 14400 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects agent with idle > maxLifetime in lifecycleConfiguration', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 10000, maxLifetime: 5000 },
    });
    expect(result.success).toBe(false);
  });

  it('omits lifecycleConfiguration from parsed output when not provided', () => {
    const result = AgentEnvSpecSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycleConfiguration).toBeUndefined();
    }
  });
});
