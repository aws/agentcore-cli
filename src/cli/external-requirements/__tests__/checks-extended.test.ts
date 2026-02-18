import type { AgentCoreProjectSpec, DirectoryPath, FilePath } from '../../../schema';
import {
  checkDependencyVersions,
  checkNodeVersion,
  formatVersionError,
  requiresContainerRuntime,
  requiresUv,
} from '../checks.js';
import { describe, expect, it } from 'vitest';

describe('formatVersionError', () => {
  it('formats missing binary error', () => {
    const result = formatVersionError({ satisfied: false, current: null, required: '18.0.0', binary: 'node' });
    expect(result).toContain("'node' not found");
    expect(result).toContain('18.0.0');
  });

  it('formats version too low error', () => {
    const result = formatVersionError({ satisfied: false, current: '16.0.0', required: '18.0.0', binary: 'node' });
    expect(result).toContain('16.0.0');
    expect(result).toContain('18.0.0');
    expect(result).toContain('below minimum');
  });

  it('formats missing uv with specific message', () => {
    const result = formatVersionError({ satisfied: false, current: null, required: 'any', binary: 'uv' });
    expect(result).toContain("'uv' not found");
    expect(result).toContain('astral-sh/uv');
  });
});

describe('requiresUv', () => {
  it('returns true when project has CodeZip agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };
    expect(requiresUv(project)).toBe(true);
  });

  it('returns false when no CodeZip agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };
    expect(requiresUv(project)).toBe(false);
  });

  it('returns false for empty agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    };
    expect(requiresUv(project)).toBe(false);
  });
});

describe('requiresContainerRuntime', () => {
  it('returns true when project has Container agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };
    expect(requiresContainerRuntime(project)).toBe(true);
  });

  it('returns false when project only has CodeZip agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };
    expect(requiresContainerRuntime(project)).toBe(false);
  });

  it('returns false for empty agents array', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    };
    expect(requiresContainerRuntime(project)).toBe(false);
  });

  it('returns true with mixed Container and CodeZip agents', () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
        {
          type: 'AgentCoreRuntime',
          name: 'Agent2',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'app.py' as FilePath,
          codeLocation: './container-app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };
    expect(requiresContainerRuntime(project)).toBe(true);
  });
});

describe('checkNodeVersion', () => {
  it('returns a version check result', async () => {
    const result = await checkNodeVersion();
    expect(result.binary).toBe('node');
    expect(result.required).toBeDefined();
    // In test environment, node should be available and satisfy minimum version
    expect(result.satisfied).toBe(true);
    expect(result.current).not.toBeNull();
  });
});

describe('checkDependencyVersions', () => {
  it('passes when node meets requirements and no uv needed', async () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    };

    const result = await checkDependencyVersions(project);
    expect(result.nodeCheck).toBeDefined();
    expect(result.nodeCheck.binary).toBe('node');
    expect(result.uvCheck).toBeNull();
  });

  it('checks uv when project has CodeZip agents', async () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [
        {
          type: 'AgentCoreRuntime',
          name: 'Agent1',
          build: 'CodeZip',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'main.py' as FilePath,
          codeLocation: './app' as DirectoryPath,
        },
      ],
      memories: [],
      credentials: [],
    };

    const result = await checkDependencyVersions(project);
    expect(result.uvCheck).not.toBeNull();
    expect(result.uvCheck!.binary).toBe('uv');
  });
});
