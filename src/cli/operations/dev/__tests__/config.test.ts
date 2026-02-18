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
      agents: [],
      memories: [],
      credentials: [],
    };

    const config = getDevConfig(workingDir, project);
    expect(config).toBeNull();
  });

  it('returns null when project has no dev-supported agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'), // Not a Python agent
          codeLocation: dirPath('./agents/node'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const config = getDevConfig(workingDir, project);
    expect(config).toBeNull();
  });

  it('returns config when project has a Python agent', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
      ],
      memories: [],
      credentials: [],
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
      ],
      memories: [],
      credentials: [],
    };

    expect(() => getDevConfig(workingDir, project, undefined, 'NonExistentAgent')).toThrow(
      'Agent "NonExistentAgent" not found'
    );
  });

  it('throws when specified agent is not Python', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'),
          codeLocation: dirPath('./agents/node'),
        },
      ],
      memories: [],
      credentials: [],
    };

    expect(() => getDevConfig(workingDir, project, undefined, 'NodeAgent')).toThrow('Dev mode only supports Python');
  });

  it('resolves directory from codeLocation relative to configRoot', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('app/PythonAgent/'),
        },
      ],
      memories: [],
      credentials: [],
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
      ],
      memories: [],
      credentials: [],
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/container'),
        },
      ],
      memories: [],
      credentials: [],
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'),
          codeLocation: dirPath('./agents/container'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config?.agentName).toBe('ContainerAgent');
    expect(config?.buildType).toBe('Container');
  });

  it('handles .py: entrypoint format (module:function)', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'FastAPIAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('app.py:handler'),
          codeLocation: dirPath('./agents/fastapi'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const config = getDevConfig(workingDir, project, '/test/project/agentcore');
    expect(config).not.toBeNull();
    expect(config!.isPython).toBe(true);
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
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/a1'),
        },
        {
          type: 'AgentCoreRuntime',
          name: 'Agent2',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/a2'),
        },
      ],
      memories: [],
      credentials: [],
    };

    expect(getAgentPort(project, 'Agent1', 8080)).toBe(8080);
    expect(getAgentPort(project, 'Agent2', 8080)).toBe(8081);
  });

  it('returns basePort when agent not found', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
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
      agents: [],
      memories: [],
      credentials: [],
    };

    expect(getDevSupportedAgents(project)).toEqual([]);
  });

  it('returns empty array when no agents are Python', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'),
          codeLocation: dirPath('./agents/node'),
        },
      ],
      memories: [],
      credentials: [],
    };

    expect(getDevSupportedAgents(project)).toEqual([]);
  });

  it('returns only Python agents with entrypoints', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
        {
          type: 'AgentCoreRuntime',
          name: 'NodeAgent',
          build: 'CodeZip',
          runtimeVersion: 'NODE_20',
          entrypoint: filePath('index.js'),
          codeLocation: dirPath('./agents/node'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(1);
    expect(supported[0]?.name).toBe('PythonAgent');
  });

  it('includes Container agents with entrypoints', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/container'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(1);
    expect(supported[0]?.name).toBe('ContainerAgent');
  });

  it('returns both Python CodeZip and Container agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'TestProject',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'PythonAgent',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('main.py'),
          codeLocation: dirPath('./agents/python'),
        },
        {
          type: 'AgentCoreRuntime',
          name: 'ContainerAgent',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: filePath('app.py'),
          codeLocation: dirPath('./agents/container'),
        },
      ],
      memories: [],
      credentials: [],
    };

    const supported = getDevSupportedAgents(project);
    expect(supported).toHaveLength(2);
  });
});
