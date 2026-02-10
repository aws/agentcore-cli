import type { AgentCoreProjectSpec, DirectoryPath, FilePath } from '../../../../schema';
import { getDevConfig, getDevSupportedAgents } from '../config';
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
});
