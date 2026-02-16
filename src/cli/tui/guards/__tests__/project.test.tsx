import { MissingProjectMessage, WrongDirectoryMessage, getProjectRootMismatch, projectExists } from '../project.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFindConfigRoot } = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  findConfigRoot: mockFindConfigRoot,
  getWorkingDirectory: () => '/project',
  NoProjectError: class extends Error {
    constructor() {
      super('No agentcore project found');
    }
  },
}));

describe('projectExists', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns true when config root is found', () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');

    expect(projectExists('/project')).toBe(true);
  });

  it('returns false when config root is not found', () => {
    mockFindConfigRoot.mockReturnValue(null);

    expect(projectExists('/project')).toBe(false);
  });

  it('uses default working directory when no baseDir provided', () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');

    projectExists();

    expect(mockFindConfigRoot).toHaveBeenCalledWith('/project');
  });
});

describe('getProjectRootMismatch', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns null when no project found', () => {
    mockFindConfigRoot.mockReturnValue(null);

    expect(getProjectRootMismatch('/somewhere')).toBeNull();
  });

  it('returns null when cwd matches project root', () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');

    expect(getProjectRootMismatch('/project')).toBeNull();
  });

  it('returns project root when cwd is a subdirectory', () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');

    const result = getProjectRootMismatch('/project/src');

    expect(result).toBe('/project');
  });
});

describe('MissingProjectMessage', () => {
  it('renders with agentcore create for CLI mode', () => {
    const { lastFrame } = render(<MissingProjectMessage />);

    expect(lastFrame()).toContain('No agentcore project found');
    expect(lastFrame()).toContain('agentcore create');
  });

  it('renders with create for TUI mode', () => {
    const { lastFrame } = render(<MissingProjectMessage inTui />);

    expect(lastFrame()).toContain('No agentcore project found');
    expect(lastFrame()).toContain('create');
  });
});

describe('WrongDirectoryMessage', () => {
  it('renders project root path', () => {
    const { lastFrame } = render(<WrongDirectoryMessage projectRoot="/home/user/my-project" />);

    expect(lastFrame()).toContain('project root directory');
    expect(lastFrame()).toContain('/home/user/my-project');
    expect(lastFrame()).toContain('cd /home/user/my-project');
  });
});
