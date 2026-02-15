import {
  NoProjectError,
  PathResolver,
  findConfigRoot,
  findProjectRoot,
  getSessionProjectRoot,
  requireConfigRoot,
  setSessionProjectRoot,
} from '../path-resolver.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('NoProjectError', () => {
  it('has default message', () => {
    const err = new NoProjectError();
    expect(err.message).toContain('No agentcore project found');
    expect(err.name).toBe('NoProjectError');
  });

  it('accepts custom message', () => {
    const err = new NoProjectError('custom msg');
    expect(err.message).toBe('custom msg');
  });

  it('is instance of Error', () => {
    expect(new NoProjectError()).toBeInstanceOf(Error);
  });
});

describe('requireConfigRoot', () => {
  it('throws NoProjectError when no project found', () => {
    const emptyDir = join(tmpdir(), `require-config-${randomUUID()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(() => requireConfigRoot(emptyDir)).toThrow(NoProjectError);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns config root when project exists', () => {
    const projectDir = join(tmpdir(), `require-config-ok-${randomUUID()}`);
    const agentcoreDir = join(projectDir, 'agentcore');
    mkdirSync(agentcoreDir, { recursive: true });
    writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
    try {
      const result = requireConfigRoot(projectDir);
      expect(result).toBe(agentcoreDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('findConfigRoot', () => {
  let projectDir: string;
  let agentcoreDir: string;

  beforeAll(() => {
    projectDir = join(tmpdir(), `find-config-${randomUUID()}`);
    agentcoreDir = join(projectDir, 'agentcore');
    mkdirSync(agentcoreDir, { recursive: true });
    writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('finds agentcore directory at start dir', () => {
    expect(findConfigRoot(projectDir)).toBe(agentcoreDir);
  });

  it('finds agentcore directory from child dir', () => {
    const childDir = join(projectDir, 'sub', 'deep');
    mkdirSync(childDir, { recursive: true });
    expect(findConfigRoot(childDir)).toBe(agentcoreDir);
  });

  it('returns null when no project found', () => {
    const emptyDir = join(tmpdir(), `find-config-empty-${randomUUID()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(findConfigRoot(emptyDir)).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('findProjectRoot', () => {
  it('returns parent of agentcore directory', () => {
    const projectDir = join(tmpdir(), `find-proj-${randomUUID()}`);
    const agentcoreDir = join(projectDir, 'agentcore');
    mkdirSync(agentcoreDir, { recursive: true });
    writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
    try {
      expect(findProjectRoot(projectDir)).toBe(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns null when no project found', () => {
    const emptyDir = join(tmpdir(), `find-proj-empty-${randomUUID()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      expect(findProjectRoot(emptyDir)).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('sessionProjectRoot', () => {
  afterEach(() => {
    // Reset by setting to a non-existent path so it won't affect other tests
    setSessionProjectRoot(join(tmpdir(), 'nonexistent-' + randomUUID()));
  });

  it('starts as null or previously set value', () => {
    // We can't guarantee initial state since other tests may have run
    const root = getSessionProjectRoot();
    expect(root === null || typeof root === 'string').toBe(true);
  });

  it('can be set and retrieved', () => {
    setSessionProjectRoot('/test/path');
    expect(getSessionProjectRoot()).toBe('/test/path');
  });

  it('findConfigRoot checks session root first', () => {
    const projectDir = join(tmpdir(), `session-proj-${randomUUID()}`);
    const agentcoreDir = join(projectDir, 'agentcore');
    mkdirSync(agentcoreDir, { recursive: true });
    writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
    try {
      setSessionProjectRoot(projectDir);
      // Should find via session root even from unrelated directory
      const emptyDir = join(tmpdir(), `session-empty-${randomUUID()}`);
      mkdirSync(emptyDir, { recursive: true });
      try {
        expect(findConfigRoot(emptyDir)).toBe(agentcoreDir);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('PathResolver', () => {
  it('uses default config when no config provided', () => {
    const resolver = new PathResolver();
    expect(resolver.getBaseDir()).toContain('agentcore');
  });

  it('uses custom baseDir', () => {
    const resolver = new PathResolver({ baseDir: '/custom/agentcore' });
    expect(resolver.getBaseDir()).toBe('/custom/agentcore');
  });

  it('getProjectRoot returns parent of baseDir', () => {
    const resolver = new PathResolver({ baseDir: '/my/project/agentcore' });
    expect(resolver.getProjectRoot()).toBe('/my/project');
  });

  it('getAgentConfigPath returns agentcore.json path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getAgentConfigPath()).toBe(join('/base', 'agentcore.json'));
  });

  it('getAWSTargetsConfigPath returns aws-targets.json path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getAWSTargetsConfigPath()).toBe(join('/base', 'aws-targets.json'));
  });

  it('getCliSystemDir returns .cli path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getCliSystemDir()).toBe(join('/base', '.cli'));
  });

  it('getLogsDir returns logs path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getLogsDir()).toBe(join('/base', '.cli', 'logs'));
  });

  it('getInvokeLogsDir returns invoke logs path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getInvokeLogsDir()).toBe(join('/base', '.cli', 'logs', 'invoke'));
  });

  it('getStatePath returns deployed-state.json path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getStatePath()).toBe(join('/base', '.cli', 'deployed-state.json'));
  });

  it('getMcpConfigPath returns mcp.json path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getMcpConfigPath()).toBe(join('/base', 'mcp.json'));
  });

  it('getMcpDefsPath returns mcp-defs.json path', () => {
    const resolver = new PathResolver({ baseDir: '/base' });
    expect(resolver.getMcpDefsPath()).toBe(join('/base', 'mcp-defs.json'));
  });

  it('setBaseDir updates the base directory', () => {
    const resolver = new PathResolver({ baseDir: '/old' });
    resolver.setBaseDir('/new');
    expect(resolver.getBaseDir()).toBe('/new');
    expect(resolver.getProjectRoot()).toBe(dirname('/new'));
  });
});
