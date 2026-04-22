import type { AgentCoreProjectSpec } from '../../../../schema';
import { validateHarnessDockerfiles } from '../preflight.js';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../../../lib', () => ({
  DOCKERFILE_NAME: 'Dockerfile',
  getDockerfilePath: (codeLocation: string, dockerfile?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('node:path') as typeof import('node:path');
    return p.join(codeLocation, dockerfile ?? 'Dockerfile');
  },
  ConfigIO: vi.fn(),
  requireConfigRoot: vi.fn(),
  resolveCodeLocation: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

const CONFIG_ROOT = '/project/agentcore';

function makeSpec(harnesses: { name: string; path: string }[]): AgentCoreProjectSpec {
  return {
    name: 'test-project',
    runtimes: [],
    harnesses,
  } as unknown as AgentCoreProjectSpec;
}

describe('validateHarnessDockerfiles', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no harnesses are defined', () => {
    const spec = makeSpec([]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when harness has no dockerfile field', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'my_harness', model: {} }));

    const spec = makeSpec([{ name: 'my_harness', path: 'harnesses/my_harness' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('does nothing when harness has containerUri (dockerfile is ignored)', () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ name: 'my_harness', dockerfile: 'Dockerfile', containerUri: 'ecr-uri' })
    );

    const spec = makeSpec([{ name: 'my_harness', path: 'harnesses/my_harness' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('passes when harness has dockerfile and file exists', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'my_harness', dockerfile: 'Dockerfile' }));
    mockedExistsSync.mockReturnValue(true);

    const spec = makeSpec([{ name: 'my_harness', path: 'harnesses/my_harness' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();
  });

  it('throws when harness has dockerfile but file does not exist', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'my_harness', dockerfile: 'Dockerfile' }));
    mockedExistsSync.mockReturnValue(false);

    const spec = makeSpec([{ name: 'my_harness', path: 'harnesses/my_harness' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).toThrow(/my_harness.*Dockerfile not found/);
  });

  it('checks for custom dockerfile name', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'gpu', dockerfile: 'Dockerfile.gpu' }));
    mockedExistsSync.mockReturnValue(true);

    const spec = makeSpec([{ name: 'gpu', path: 'harnesses/gpu' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();

    const calledPath = mockedExistsSync.mock.calls[0]?.[0] as string;
    expect(calledPath).toContain('Dockerfile.gpu');
  });

  it('continues if harness.json cannot be read', () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const spec = makeSpec([{ name: 'broken', path: 'harnesses/broken' }]);
    expect(() => validateHarnessDockerfiles(spec, CONFIG_ROOT)).not.toThrow();
  });
});
