import type { AgentCoreProjectSpec, DirectoryPath, FilePath } from '../../../schema';
import {
  checkDependencyVersions,
  checkNodeVersion,
  checkNpmCacheOwnership,
  formatNpmCacheError,
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
          protocol: 'HTTP',
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
          protocol: 'HTTP',
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
          protocol: 'HTTP',
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
          protocol: 'HTTP',
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
          protocol: 'HTTP',
        },
        {
          type: 'AgentCoreRuntime',
          name: 'Agent2',
          build: 'Container',
          runtimeVersion: 'PYTHON_3_12',
          entrypoint: 'app.py' as FilePath,
          codeLocation: './container-app' as DirectoryPath,
          protocol: 'HTTP',
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

describe('checkNpmCacheOwnership', () => {
  it('returns a result with expected structure', async () => {
    const result = await checkNpmCacheOwnership();
    expect(result).toHaveProperty('satisfied');
    expect(result).toHaveProperty('owner');
    expect(result).toHaveProperty('cacheDir');
    expect(result.cacheDir).toContain('.npm');
  });

  it('is satisfied when cache is owned by current user', async () => {
    // In a normal test environment, ~/.npm should be owned by the current user
    const result = await checkNpmCacheOwnership();
    expect(result.satisfied).toBe(true);
  });
});

describe('formatNpmCacheError', () => {
  it('includes cache directory path', () => {
    const msg = formatNpmCacheError({ satisfied: false, owner: 'root', cacheDir: '/home/user/.npm' });
    expect(msg).toContain('/home/user/.npm');
  });

  it('includes the wrong owner name', () => {
    const msg = formatNpmCacheError({ satisfied: false, owner: 'root', cacheDir: '/home/user/.npm' });
    expect(msg).toContain('root');
  });

  it('includes the fix command', () => {
    const msg = formatNpmCacheError({ satisfied: false, owner: 'root', cacheDir: '/home/user/.npm' });
    expect(msg).toContain('sudo chown -R $(whoami)');
  });

  it('mentions sudo npm install as likely cause', () => {
    const msg = formatNpmCacheError({ satisfied: false, owner: 'root', cacheDir: '/home/user/.npm' });
    expect(msg).toContain('sudo npm install');
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

  it('includes npmCacheCheck in result', async () => {
    const project: AgentCoreProjectSpec = {
      name: 'Test',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    };

    const result = await checkDependencyVersions(project);
    expect(result.npmCacheCheck).toBeDefined();
    expect(result.npmCacheCheck.cacheDir).toContain('.npm');
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
          protocol: 'HTTP',
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
