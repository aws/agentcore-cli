import type { AgentCoreProjectSpec, DirectoryPath, FilePath } from '../../../../schema';
import { getAgentPort, getDevConfig, getDevSupportedAgents } from '../config';
import { describe, expect, it } from 'vitest';

// Helper to cast strings to branded path types for testing
const filePath = (s: string) => s as FilePath;
const dirPath = (s: string) => s as DirectoryPath;

describe('getDevConfig', () => {
  const workingDir = '/test/project';

  it('returns null when project has no agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project);
    expect(config).toBeNull();
  });

  it('returns null when project has no dev-supported agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      // Agent with no entrypoint — not dev-supported
      runtimes: [
        {
          name: 'BrokenAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath(''),
          codeLocation: dirPath('./agents/broken'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project);
    expect(config).toBeNull();
  });

  it('returns config when project has a Python agent', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config?.agentName).toBe('PythonAgent');
    expect(config?.module).toBe('main.py');
  });

  it('throws when project is null', () => {
    expect(() => getDevConfig(workingDir, null)).toThrow('No project configuration found');
  });

  it('throws when specified agent not found', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    expect(() => getDevConfig(workingDir, project, undefined, 'NonExistentAgent')).toThrow(
      'Agent "NonExistentAgent" not found'
    );
  });

  it('returns TypeScript config when project has a Node agent with .ts entrypoint', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'TsAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_22',
          entrypoint: filePath('main.ts'),
          codeLocation: dirPath('./agents/ts'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, undefined, 'TsAgent');
    expect(config).not.toBeNull();
    expect(config?.agentName).toBe('TsAgent');
    expect(config?.isPython).toBe(false);
  });

  it('resolves directory from codeLocation relative to configRoot', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('app/PythonAgent/'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    // codeLocation is relative, so it should resolve relative to project root (parent of configRoot)
    expect(config!.directory).toContain('app/PythonAgent');
  });

  it('uses workingDir when no configRoot or codeLocation', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    // No configRoot provided
    const config = getDevConfig(workingDir, project);
    expect(config).not.toBeNull();
    expect(config!.directory).toBe(workingDir);
  });

  it('returns config for Container agent with buildType Container', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/container'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config?.agentName).toBe('ContainerAgent');
    expect(config?.buildType).toBe('Container');
  });

  it('returns config for Container agent regardless of runtime version', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'),
          codeLocation: dirPath('./agents/container'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config?.agentName).toBe('ContainerAgent');
    expect(config?.buildType).toBe('Container');
  });

  it('returns protocol HTTP by default when agent has no protocol', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config!.protocol).toBe('HTTP');
  });

  it('returns protocol MCP for MCP agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'McpAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/mcp'),
          protocol: 'MCP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config!.protocol).toBe('MCP');
  });

  it('returns protocol A2A for A2A agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'A2aAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/a2a'),
          protocol: 'A2A',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config!.protocol).toBe('A2A');
  });

  it('handles .py: entrypoint format (module:function)', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'FastAPIAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('app.py:handler'),
          codeLocation: dirPath('./agents/fastapi'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config!.isPython).toBe(true);
  });

  it('threads dockerfile from Container agent spec to DevConfig', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/container'),
          protocol: 'HTTP',
          dockerfile: 'Dockerfile.gpu',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config?.dockerfile).toBe('Dockerfile.gpu');
  });
});

describe('getAgentPort', () => {
  it('returns basePort when project is null', () => {
    expect(getAgentPort(null, 'any', 8080)).toBe(8080);
  });

  it('returns basePort + index for found agent', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/a1'),
          protocol: 'HTTP',
        },
        {
          name: 'Agent2',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/a2'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    expect(getAgentPort(project, 'Agent1', 8080)).toBe(8080);
    expect(getAgentPort(project, 'Agent2', 8080)).toBe(8081);
  });

  it('returns basePort when agent not found', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    expect(getAgentPort(project, 'NonExistent', 9000)).toBe(9000);
  });
});

describe('getDevSupportedAgents', () => {
  it('returns empty array when project is null', () => {
    expect(getDevSupportedAgents(null)).toEqual([]);
  });

  it('returns empty array when project has no agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    expect(getDevSupportedAgents(project)).toEqual([]);
  });

  it('returns Node agents as dev-supported alongside Python', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_22',
          entrypoint: filePath('main.ts'),
          codeLocation: dirPath('./agents/node'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(1);
    expect(supported[0]?.name).toBe('NodeAgent');
  });

  it('returns both Python and Node agents with entrypoints', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
          protocol: 'HTTP',
        },
        {
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_22',
          entrypoint: filePath('main.ts'),
          codeLocation: dirPath('./agents/node'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported.map(a => a.name)).toEqual(['PythonAgent', 'NodeAgent']);
  });

  it('includes Container agents with entrypoints', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/container'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(1);
    expect(supported[0]?.name).toBe('ContainerAgent');
  });

  it('returns both Python CodeZip and Container agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
          protocol: 'HTTP',
        },
        {
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('app.py'),
          codeLocation: dirPath('./agents/container'),
          protocol: 'HTTP',
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      datasets: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(2);
  });
});
