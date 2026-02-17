import { MissingProjectMessage, WrongDirectoryMessage, getProjectRootMismatch, projectExists } from '../project.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFindConfigRoot, mockGetWorkingDirectory } = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn(),
  mockGetWorkingDirectory: vi.fn(() => '/project'),
}));

vi.mock('../../../../lib/index.js', () => ({
  findConfigRoot: mockFindConfigRoot,
  getWorkingDirectory: mockGetWorkingDirectory,
  NoProjectError: class NoProjectError extends Error {
    constructor(message = 'No agentcore project found') {
      super(message);
      this.name = 'NoProjectError';
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

  it('passes baseDir to findConfigRoot when provided', () => {
    mockFindConfigRoot.mockReturnValue(null);

    projectExists('/custom/path');

    expect(mockFindConfigRoot).toHaveBeenCalledWith('/custom/path');
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
  it('renders error message and "agentcore create" for CLI mode', () => {
    const { lastFrame } = render(<MissingProjectMessage />);
    const frame = lastFrame()!;

    expect(frame).toContain('No agentcore project found');
    expect(frame).toContain('agentcore create');
  });

  it('renders "create" without "agentcore" prefix for TUI mode', () => {
    const { lastFrame } = render(<MissingProjectMessage inTui />);
    const frame = lastFrame()!;

    expect(frame).toContain('No agentcore project found');
    expect(frame).toContain('create');
    // In TUI mode, should NOT show the full CLI command
    const lines = frame.split('\n');
    const createLine = lines.find(l => l.includes('create'))!;
    expect(createLine).not.toContain('agentcore create');
  });
});

describe('WrongDirectoryMessage', () => {
  it('renders project root path with cd suggestion', () => {
    const { lastFrame } = render(<WrongDirectoryMessage projectRoot="/home/user/my-project" />);
    const frame = lastFrame()!;

    expect(frame).toContain('project root directory');
    expect(frame).toContain('/home/user/my-project');
    expect(frame).toContain('cd /home/user/my-project');
  });
});
