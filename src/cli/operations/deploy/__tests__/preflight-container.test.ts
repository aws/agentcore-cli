import type { AgentCoreProjectSpec, DirectoryPath } from '../../../../schema';
import { validateContainerAgents } from '../preflight.js';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../../../../lib', () => ({
  DOCKERFILE_NAME: 'Dockerfile',
  resolveCodeLocation: vi.fn((codeLocation: string, configBaseDir: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('node:path') as typeof import('node:path');
    const repoRoot = p.dirname(configBaseDir);
    return p.resolve(repoRoot, codeLocation);
  }),
  // Stub other exports that the module may pull in
  ConfigIO: vi.fn(),
  requireConfigRoot: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);

const CONFIG_ROOT = '/project/agentcore';

/** Helper to cast plain strings to the branded DirectoryPath type used by the schema. */
const dir = (s: string) => s as DirectoryPath;

function makeSpec(agents: Record<string, unknown>[]): AgentCoreProjectSpec {
  return {
    name: 'test-project',
    agents,
  } as unknown as AgentCoreProjectSpec;
}

describe('validateContainerAgents', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when there are no Container agents', () => {
    const spec = makeSpec([{ name: 'zip-agent', build: 'CodeZip', codeLocation: dir('agents/zip-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('does nothing when Container agent has a valid Dockerfile', () => {
    mockedExistsSync.mockReturnValue(true);

    const spec = makeSpec([
      { name: 'container-agent', build: 'Container', codeLocation: dir('agents/container-agent') },
    ]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it('throws when Container agent is missing a Dockerfile', () => {
    mockedExistsSync.mockReturnValue(false);

    const spec = makeSpec([{ name: 'my-container', build: 'Container', codeLocation: dir('agents/my-container') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).toThrow(/Dockerfile not found/);
  });

  it('only validates Container agents and skips CodeZip agents', () => {
    mockedExistsSync.mockReturnValue(true);

    const spec = makeSpec([
      { name: 'zip-agent', build: 'CodeZip', codeLocation: dir('agents/zip-agent') },
      { name: 'container-agent', build: 'Container', codeLocation: dir('agents/container-agent') },
    ]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    // Only the Container agent should trigger an existsSync check
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it('includes the agent name in the error message', () => {
    mockedExistsSync.mockReturnValue(false);

    const spec = makeSpec([{ name: 'bad-agent', build: 'Container', codeLocation: dir('agents/bad-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).toThrow(/bad-agent/);
  });

  it('reports errors for all failing Container agents', () => {
    mockedExistsSync.mockReturnValue(false);

    const spec = makeSpec([
      { name: 'agent-a', build: 'Container', codeLocation: dir('agents/a') },
      { name: 'agent-b', build: 'Container', codeLocation: dir('agents/b') },
    ]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).toThrow(/agent-a.*agent-b/s);
  });
});
