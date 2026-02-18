import { useProject } from '../useProject.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFindConfigRoot } = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  findConfigRoot: mockFindConfigRoot,
  NoProjectError: class NoProjectError extends Error {
    constructor() {
      super('No agentcore project found');
      this.name = 'NoProjectError';
    }
  },
}));

function Harness() {
  const { hasProject, project, error } = useProject();
  return (
    <Text>
      hasProject:{String(hasProject)} configRoot:{project?.configRoot ?? 'null'} projectRoot:
      {project?.projectRoot ?? 'null'} error:{error ?? 'null'}
    </Text>
  );
}

describe('useProject', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns hasProject=true with correct paths when config found', () => {
    mockFindConfigRoot.mockReturnValue('/home/user/my-project/agentcore');

    const { lastFrame } = render(<Harness />);

    expect(lastFrame()).toContain('hasProject:true');
    expect(lastFrame()).toContain('configRoot:/home/user/my-project/agentcore');
    expect(lastFrame()).toContain('error:null');
  });

  it('returns hasProject=false with error when no config found', () => {
    mockFindConfigRoot.mockReturnValue(null);

    const { lastFrame } = render(<Harness />);

    expect(lastFrame()).toContain('hasProject:false');
    expect(lastFrame()).toContain('configRoot:null');
    expect(lastFrame()).toContain('error:No agentcore project found');
  });

  it('projectRoot is parent directory of configRoot', () => {
    mockFindConfigRoot.mockReturnValue('/a/b/c/agentcore');

    const { lastFrame } = render(<Harness />);

    expect(lastFrame()).toContain('projectRoot:/a/b/c');
  });
});
