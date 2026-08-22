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
  RuntimeEndpointNameSchema,
  RuntimeEndpointSchema,
} from '../agent-env.js';
import { describe, expect, it } from 'vitest';

describe('AgentNameSchema', () => {
  it('accepts valid names', () => {
    expect(AgentNameSchema.safeParse('Agent1').success).toBe(true);
    expect(AgentNameSchema.safeParse('A').success).toBe(true);
    expect(AgentNameSchema.safeParse('agent_with_underscores').success).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(AgentNameSchema.safeParse('').success).toBe(false);
    expect(AgentNameSchema.safeParse('1Agent').success).toBe(false);
    expect(AgentNameSchema.safeParse('my-agent').success).toBe(false);
  });

  it('enforces 48-char boundary', () => {
    expect(AgentNameSchema.safeParse('A' + 'b'.repeat(47)).success).toBe(true);
    expect(AgentNameSchema.safeParse('A' + 'b'.repeat(48)).success).toBe(false);
  });
});

describe('EnvVarNameSchema', () => {
  it('accepts valid env var names and rejects invalid', () => {
    expect(EnvVarNameSchema.safeParse('MY_VAR').success).toBe(true);
    expect(EnvVarNameSchema.safeParse('_private').success).toBe(true);
    expect(EnvVarNameSchema.safeParse('1VAR').success).toBe(false);
    expect(EnvVarNameSchema.safeParse('MY-VAR').success).toBe(false);
    expect(EnvVarNameSchema.safeParse('').success).toBe(false);
  });
});

describe('GatewayNameSchema', () => {
  it('accepts valid names and rejects invalid', () => {
    expect(GatewayNameSchema.safeParse('gateway1').success).toBe(true);
    expect(GatewayNameSchema.safeParse('my-gateway').success).toBe(true);
    expect(GatewayNameSchema.safeParse('').success).toBe(false);
    expect(GatewayNameSchema.safeParse('my_gateway').success).toBe(false);
    expect(GatewayNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
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
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
    protocol: 'HTTP',
  };

  const validNodeAgent = {
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
    for (const version of ['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13', 'PYTHON_3_14']) {
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

  it('rejects missing required fields', () => {
    expect(AgentEnvSpecSchema.safeParse({}).success).toBe(false);
    expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, name: undefined }).success).toBe(false);
  });

  describe('protocol', () => {
    it('accepts valid protocols', () => {
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'HTTP' }).success).toBe(true);
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'MCP' }).success).toBe(true);
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'A2A' }).success).toBe(true);
    });

    it('accepts agent without protocol (backwards compat)', () => {
      const { protocol: _protocol, ...agentWithoutProtocol } = { ...validPythonAgent, protocol: undefined };
      expect(AgentEnvSpecSchema.safeParse(agentWithoutProtocol).success).toBe(true);
    });

    it('rejects invalid protocol', () => {
      expect(AgentEnvSpecSchema.safeParse({ ...validPythonAgent, protocol: 'GRPC' }).success).toBe(false);
    });
  });
});

describe('NetworkConfigSchema — strict AWS ID format', () => {
  it('accepts 8-char lowercase-hex IDs', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-0a1b2c3d'], securityGroups: ['sg-0a1b2c3d'] }).success
    ).toBe(true);
  });

  it('accepts 17-char lowercase-hex IDs', () => {
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-0a1b2c3d4e5f60718'],
        securityGroups: ['sg-0a1b2c3d4e5f60718'],
        vpcId: 'vpc-0a1b2c3d4e5f60718',
      }).success
    ).toBe(true);
  });

  it('rejects uppercase vpcId', () => {
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-0a1b2c3d'],
        securityGroups: ['sg-0a1b2c3d'],
        vpcId: 'vpc-ABCDEFGH',
      }).success
    ).toBe(false);
  });

  it('rejects non-hex vpcId', () => {
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-0a1b2c3d'],
        securityGroups: ['sg-0a1b2c3d'],
        vpcId: 'vpc-zzzzzzzz',
      }).success
    ).toBe(false);
  });

  it('rejects 9-char vpcId', () => {
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-0a1b2c3d'],
        securityGroups: ['sg-0a1b2c3d'],
        vpcId: 'vpc-123456789',
      }).success
    ).toBe(false);
  });

  it('rejects too-short vpcId', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-0a1b2c3d'], securityGroups: ['sg-0a1b2c3d'], vpcId: 'vpc-xyz' })
        .success
    ).toBe(false);
  });

  it('rejects uppercase subnet ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-ABCDEFGH'], securityGroups: ['sg-0a1b2c3d'] }).success
    ).toBe(false);
  });

  it('rejects non-hex subnet ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-zzzzzzzz'], securityGroups: ['sg-0a1b2c3d'] }).success
    ).toBe(false);
  });

  it('rejects 9-char subnet ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-123456789'], securityGroups: ['sg-0a1b2c3d'] }).success
    ).toBe(false);
  });

  it('rejects uppercase security group ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-0a1b2c3d'], securityGroups: ['sg-ABCDEFGH'] }).success
    ).toBe(false);
  });

  it('rejects non-hex security group ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-0a1b2c3d'], securityGroups: ['sg-zzzzzzzz'] }).success
    ).toBe(false);
  });

  it('rejects 9-char security group ID', () => {
    expect(
      NetworkConfigSchema.safeParse({ subnets: ['subnet-0a1b2c3d'], securityGroups: ['sg-123456789'] }).success
    ).toBe(false);
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

describe('AgentEnvSpecSchema - dockerfile', () => {
  const validContainerAgent = {
    name: 'ContainerAgent',
    build: 'Container',
    entrypoint: 'main.py',
    codeLocation: './agents/container',
  };

  const validCodeZipAgent = {
    name: 'CodeZipAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('accepts Container agent with custom dockerfile', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'Dockerfile.gpu' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dockerfile).toBe('Dockerfile.gpu');
    }
  });

  it('accepts Container agent without dockerfile (optional)', () => {
    const result = AgentEnvSpecSchema.safeParse(validContainerAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dockerfile).toBeUndefined();
    }
  });

  it('accepts valid dockerfile names', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'Dockerfile' }).success).toBe(true);
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'Dockerfile.gpu-v2' }).success).toBe(
      true
    );
  });

  it('accepts a relative subpath (resolved against the build context)', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'docker/Dockerfile' }).success).toBe(
      true
    );
  });

  it('rejects dockerfile on CodeZip builds', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validCodeZipAgent, dockerfile: 'Dockerfile.custom' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('only allowed for Container'))).toBe(true);
    }
  });

  it('rejects path traversal and absolute paths in dockerfile', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '../Dockerfile' }).success).toBe(false);
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'a/../secret' }).success).toBe(false);
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '/etc/Dockerfile' }).success).toBe(false);
  });

  it('rejects empty string dockerfile', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '' }).success).toBe(false);
  });

  it('rejects shell metacharacters in dockerfile', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'Dockerfile;rm -rf /' }).success).toBe(
      false
    );
  });

  it('rejects dockerfile exceeding 255 characters', () => {
    const longName = 'D' + 'a'.repeat(255);
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: longName }).success).toBe(false);
  });

  it('accepts dockerfile at exactly 255 characters', () => {
    const maxName = 'D' + 'a'.repeat(254);
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: maxName }).success).toBe(true);
  });

  it('rejects backslash path traversal in dockerfile', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '\\\\server\\share' }).success).toBe(
      false
    );
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '..\\Dockerfile' }).success).toBe(false);
  });

  it('rejects a trailing slash (a directory-shaped value would make `docker build -f docker/` fail)', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'docker/' }).success).toBe(false);
  });

  it('rejects an empty path segment (double slash)', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: 'a//Dockerfile' }).success).toBe(false);
  });

  it('accepts a leading-dot directory (e.g. .docker/Dockerfile)', () => {
    expect(AgentEnvSpecSchema.safeParse({ ...validContainerAgent, dockerfile: '.docker/Dockerfile' }).success).toBe(
      true
    );
  });
});

describe('AgentEnvSpecSchema - buildContextPath', () => {
  const validContainerAgent = {
    name: 'ContainerAgent',
    build: 'Container',
    entrypoint: 'main.py',
    codeLocation: './agents/container',
  };

  const validCodeZipAgent = {
    name: 'CodeZipAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('accepts Container agent with buildContextPath', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validContainerAgent, buildContextPath: '.' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.buildContextPath).toBe('.');
    }
  });

  it('accepts Container agent without buildContextPath (optional)', () => {
    const result = AgentEnvSpecSchema.safeParse(validContainerAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.buildContextPath).toBeUndefined();
    }
  });

  it('rejects buildContextPath on CodeZip builds', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validCodeZipAgent, buildContextPath: '.' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('only allowed for Container'))).toBe(true);
    }
  });
});

describe('AgentEnvSpecSchema - customDockerBuildArgs', () => {
  const validContainerAgent = {
    name: 'ContainerAgent',
    build: 'Container',
    entrypoint: 'main.py',
    codeLocation: './agents/container',
  };

  const validCodeZipAgent = {
    name: 'CodeZipAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/test',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('accepts Container agent with customDockerBuildArgs', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validContainerAgent,
      customDockerBuildArgs: { AGENT_NAME: 'dummyagent', BUILD_ENV: 'prod' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customDockerBuildArgs).toEqual({ AGENT_NAME: 'dummyagent', BUILD_ENV: 'prod' });
    }
  });

  it('accepts Container agent without customDockerBuildArgs (optional)', () => {
    const result = AgentEnvSpecSchema.safeParse(validContainerAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customDockerBuildArgs).toBeUndefined();
    }
  });

  it('rejects customDockerBuildArgs on CodeZip builds', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validCodeZipAgent, customDockerBuildArgs: { KEY: 'val' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('only allowed for Container'))).toBe(true);
    }
  });

  it('accepts empty customDockerBuildArgs object', () => {
    const result = AgentEnvSpecSchema.safeParse({ ...validContainerAgent, customDockerBuildArgs: {} });
    expect(result.success).toBe(true);
  });

  it('rejects a key that is not a valid identifier', () => {
    expect(
      AgentEnvSpecSchema.safeParse({ ...validContainerAgent, customDockerBuildArgs: { 'has-dash': 'v' } }).success
    ).toBe(false);
  });

  it.each([
    'IMAGE_URI',
    'ECR_REGISTRY',
    'DOCKERFILE_PATH',
    'BUILD_ARG_FLAGS',
    'AWS_DEFAULT_REGION',
    'CODEBUILD_FOO',
    'PATH',
    'HOME',
    'IFS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
  ])('rejects the build-environment-reserved key %s (would break only on deploy)', key => {
    const result = AgentEnvSpecSchema.safeParse({ ...validContainerAgent, customDockerBuildArgs: { [key]: 'v' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('reserved by the build environment'))).toBe(true);
    }
  });

  it.each(['USER', 'LANG', 'SHELL', 'TERM'])('accepts the common non-dangerous build-arg key %s', key => {
    // Legitimate Dockerfile ARGs (e.g. `ARG USER` -> `useradd $USER`) must not be over-rejected.
    const result = AgentEnvSpecSchema.safeParse({ ...validContainerAgent, customDockerBuildArgs: { [key]: 'v' } });
    expect(result.success).toBe(true);
  });

  it('accepts a normal value with spaces and symbols', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validContainerAgent,
      customDockerBuildArgs: { GREETING: 'hello world = ok!' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a value containing a newline or control character', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validContainerAgent,
      customDockerBuildArgs: { BAD: 'line1\nline2' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('control characters'))).toBe(true);
    }
  });

  it('rejects a value longer than 4096 characters', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validContainerAgent,
      customDockerBuildArgs: { BIG: 'x'.repeat(4097) },
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentEnvSpecSchema - lifecycleConfiguration', () => {
  const validAgent = {
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

describe('RuntimeEndpointNameSchema', () => {
  it('accepts valid names', () => {
    expect(RuntimeEndpointNameSchema.safeParse('prod').success).toBe(true);
    expect(RuntimeEndpointNameSchema.safeParse('myEndpoint').success).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(RuntimeEndpointNameSchema.safeParse('').success).toBe(false);
    expect(RuntimeEndpointNameSchema.safeParse('1prod').success).toBe(false);
    expect(RuntimeEndpointNameSchema.safeParse('my-endpoint').success).toBe(false);
    expect(RuntimeEndpointNameSchema.safeParse('prod!').success).toBe(false);
  });

  it('enforces 48-char boundary', () => {
    expect(RuntimeEndpointNameSchema.safeParse('A' + 'b'.repeat(47)).success).toBe(true);
    expect(RuntimeEndpointNameSchema.safeParse('A' + 'b'.repeat(48)).success).toBe(false);
  });
});

describe('RuntimeEndpointSchema', () => {
  it('accepts endpoint with version only', () => {
    const result = RuntimeEndpointSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
  });

  it('accepts endpoint with version and description', () => {
    const result = RuntimeEndpointSchema.safeParse({ version: 3, description: 'Production endpoint' });
    expect(result.success).toBe(true);
  });

  it('rejects version < 1', () => {
    expect(RuntimeEndpointSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(RuntimeEndpointSchema.safeParse({ version: -1 }).success).toBe(false);
  });

  it('rejects non-integer version', () => {
    expect(RuntimeEndpointSchema.safeParse({ version: 1.5 }).success).toBe(false);
  });

  it('rejects missing version', () => {
    expect(RuntimeEndpointSchema.safeParse({}).success).toBe(false);
    expect(RuntimeEndpointSchema.safeParse({ description: 'no version' }).success).toBe(false);
  });
});

describe('AgentEnvSpecSchema - endpoints', () => {
  const validAgent = {
    name: 'TestAgent',
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: 'app/TestAgent/',
    runtimeVersion: 'PYTHON_3_12',
  };

  it('accepts valid endpoints dictionary', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      endpoints: {
        prod: { version: 3, description: 'Production' },
        staging: { version: 2 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints).toEqual({
        prod: { version: 3, description: 'Production' },
        staging: { version: 2 },
      });
    }
  });

  it('accepts agent without endpoints (optional)', () => {
    const result = AgentEnvSpecSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints).toBeUndefined();
    }
  });

  it('rejects invalid endpoint name with special characters', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      endpoints: {
        'my-endpoint': { version: 1 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects endpoint with version < 1', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      endpoints: {
        prod: { version: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts endpoint with only version (no description)', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...validAgent,
      endpoints: {
        prod: { version: 5 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints!.prod).toEqual({ version: 5 });
    }
  });
});

describe('NetworkConfigSchema - vpcId', () => {
  it('accepts valid vpcId', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-12345678'],
      vpcId: 'vpc-12345678',
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed vpcId', () => {
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
        vpcId: 'invalid-vpc',
      }).success
    ).toBe(false);
    expect(
      NetworkConfigSchema.safeParse({
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
        vpcId: 'vpc-1234567',
      }).success
    ).toBe(false);
  });

  it('omits vpcId when not provided (optional)', () => {
    const result = NetworkConfigSchema.safeParse({
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-12345678'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vpcId).toBeUndefined();
    }
  });
});

describe('AgentEnvSpecSchema - vpcId validation', () => {
  const baseVpcAgent = {
    name: 'VpcAgent',
    build: 'Container',
    entrypoint: 'main.py',
    codeLocation: './agents/vpc',
    networkMode: 'VPC',
    networkConfig: {
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-12345678'],
    },
  };

  it('accepts a Container+VPC agent WITHOUT vpcId at the schema level (backfilled at deploy)', () => {
    // vpcId is required to build, but NOT enforced on read/write: pre-existing agentcore.json files
    // written before the vpcId field existed must still load. The CLI validators require --vpc-id for
    // fresh creates, deploy backfills a missing vpcId from the subnets, and the CDK construct fails
    // fast at synth. Keeping the schema lenient is what lets status/remove/validate work on old configs.
    const result = AgentEnvSpecSchema.safeParse(baseVpcAgent);
    expect(result.success).toBe(true);
  });

  it('accepts Container+VPC agent with vpcId', () => {
    const result = AgentEnvSpecSchema.safeParse({
      ...baseVpcAgent,
      networkConfig: {
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
        vpcId: 'vpc-12345678',
      },
    });
    expect(result.success).toBe(true);
  });

  it('does not require vpcId for CodeZip+VPC', () => {
    const result = AgentEnvSpecSchema.safeParse({
      name: 'CodeZipVpcAgent',
      build: 'CodeZip',
      entrypoint: 'main.py:handler',
      codeLocation: './agents/codezipvpc',
      runtimeVersion: 'PYTHON_3_12',
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-12345678'],
        securityGroups: ['sg-12345678'],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentEnvSpecSchema — SG≤5 for Container builds in VPC mode', () => {
  const sixSgs = [
    'sg-00000000000000001',
    'sg-00000000000000002',
    'sg-00000000000000003',
    'sg-00000000000000004',
    'sg-00000000000000005',
    'sg-00000000000000006',
  ];
  const fiveSgs = sixSgs.slice(0, 5);

  it('rejects Container+VPC with 6 security groups', () => {
    const result = AgentEnvSpecSchema.safeParse({
      name: 'ContainerVpcAgent',
      build: 'Container',
      entrypoint: 'main.py',
      codeLocation: './agents/container',
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: sixSgs,
        vpcId: 'vpc-0123456789abcdef0',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('5 security groups'))).toBe(true);
    }
  });

  it('accepts Container+VPC with exactly 5 security groups', () => {
    const result = AgentEnvSpecSchema.safeParse({
      name: 'ContainerVpcAgent',
      build: 'Container',
      entrypoint: 'main.py',
      codeLocation: './agents/container',
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: fiveSgs,
        vpcId: 'vpc-0123456789abcdef0',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts CodeZip+VPC with 6 security groups (no CodeBuild, no cap)', () => {
    const result = AgentEnvSpecSchema.safeParse({
      name: 'CodeZipVpcAgent',
      build: 'CodeZip',
      entrypoint: 'main.py:handler',
      codeLocation: './agents/codezipvpc',
      runtimeVersion: 'PYTHON_3_12',
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: sixSgs,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentEnvSpecSchema — capacityProviderConfiguration (J2)', () => {
  const base = {
    name: 'CpAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/cp',
    runtimeVersion: 'PYTHON_3_12',
    protocol: 'HTTP',
  };
  const CP_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/my_pool-a1b2c3d4e5';

  it('accepts a sibling capacity provider by name', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts an external capacity provider by ARN', () => {
    const r = AgentEnvSpecSchema.safeParse({ ...base, capacityProviderConfiguration: { capacityProviderArn: CP_ARN } });
    expect(r.success).toBe(true);
  });

  it('rejects setting both name and ARN', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool', capacityProviderArn: CP_ARN },
    });
    expect(r.success).toBe(false);
  });

  it('rejects setting neither name nor ARN', () => {
    const r = AgentEnvSpecSchema.safeParse({ ...base, capacityProviderConfiguration: {} });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed capacity provider ARN', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/x' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects capacity provider combined with VPC networkMode', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
      networkMode: 'VPC',
      networkConfig: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects capacity provider combined with an explicit PUBLIC networkMode', () => {
    // networkMode is not settable at all on a CP-attached runtime — not even PUBLIC. The CP
    // supplies the network topology, so the runtime must leave networkMode unset.
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
      networkMode: 'PUBLIC',
    });
    expect(r.success).toBe(false);
  });
});

describe('AgentEnvSpecSchema — capacityProviderVolume filesystem mount (J3)', () => {
  const base = {
    name: 'CpVolAgent',
    build: 'CodeZip',
    entrypoint: 'main.py:handler',
    codeLocation: './agents/cpvol',
    runtimeVersion: 'PYTHON_3_12',
    protocol: 'HTTP',
  };

  it('accepts a capacityProviderVolume mount when attached to a capacity provider', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
      filesystemConfigurations: [{ capacityProviderVolume: { volumeName: 'model-weights', mountPath: '/mnt/models' } }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a capacityProviderVolume mount without a capacity provider attachment', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      filesystemConfigurations: [{ capacityProviderVolume: { volumeName: 'model-weights', mountPath: '/mnt/models' } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a bad mount path', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
      filesystemConfigurations: [
        { capacityProviderVolume: { volumeName: 'model-weights', mountPath: '/data/models' } },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate mount paths across arms', () => {
    const r = AgentEnvSpecSchema.safeParse({
      ...base,
      capacityProviderConfiguration: { capacityProviderName: 'my_pool' },
      filesystemConfigurations: [
        { sessionStorage: { mountPath: '/mnt/models' } },
        { capacityProviderVolume: { volumeName: 'model-weights', mountPath: '/mnt/models' } },
      ],
    });
    expect(r.success).toBe(false);
  });
});
