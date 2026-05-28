import type { AgentCoreProjectSpec, DirectoryPath } from '../../../../schema';
import { validateContainerAgents } from '../preflight.js';
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
const mockedReadFileSync = vi.mocked(readFileSync);

const CONFIG_ROOT = '/project/agentcore';

/** Helper to cast plain strings to the branded DirectoryPath type used by the schema. */
const dir = (s: string) => s as DirectoryPath;

function makeSpec(runtimes: Record<string, unknown>[]): AgentCoreProjectSpec {
  return {
    name: 'test-project',
    runtimes,
  } as unknown as AgentCoreProjectSpec;
}

describe('validateContainerAgents', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Default readFileSync to return a safe Dockerfile so the warning check doesn't fail on unrelated tests
  function mockValidDockerfile(): void {
    mockedReadFileSync.mockReturnValue('FROM public.ecr.aws/docker/library/python:3.12-slim-trixie\n');
  }

  it('does nothing when there are no Container agents', () => {
    const spec = makeSpec([{ name: 'zip-agent', build: 'CodeZip', codeLocation: dir('agents/zip-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('does nothing when Container agent has a valid Dockerfile', () => {
    mockedExistsSync.mockReturnValue(true);
    mockValidDockerfile();

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
    mockValidDockerfile();

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

  it('checks for custom dockerfile name when specified', () => {
    mockedExistsSync.mockReturnValue(true);
    mockValidDockerfile();

    const spec = makeSpec([
      { name: 'gpu-agent', build: 'Container', codeLocation: dir('agents/gpu'), dockerfile: 'Dockerfile.gpu' },
    ]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    // Should check for Dockerfile.gpu, not the default Dockerfile
    const calledPath = mockedExistsSync.mock.calls[0]?.[0] as string;
    expect(calledPath).toContain('Dockerfile.gpu');
  });

  it('throws with custom dockerfile name in error message when missing', () => {
    mockedExistsSync.mockReturnValue(false);

    const spec = makeSpec([
      { name: 'gpu-agent', build: 'Container', codeLocation: dir('agents/gpu'), dockerfile: 'Dockerfile.gpu' },
    ]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).toThrow(/Dockerfile\.gpu not found/);
  });

  it('warns when Dockerfile uses deprecated bookworm base image', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm\nRUN pip install uv'
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const spec = makeSpec([{ name: 'my-agent', build: 'Container', codeLocation: dir('agents/my-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CVE-2026-42010'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('my-agent'));

    warnSpy.mockRestore();
  });

  it('does not warn when Dockerfile uses trixie base image', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'FROM public.ecr.aws/docker/library/python:3.12-slim-trixie\nRUN pip install uv'
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const spec = makeSpec([{ name: 'my-agent', build: 'Container', codeLocation: dir('agents/my-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does not warn when bookworm appears in a non-FROM line', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'FROM public.ecr.aws/docker/library/python:3.12-slim-trixie\n# migrated from slim-bookworm\nRUN pip install uv'
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const spec = makeSpec([{ name: 'my-agent', build: 'Container', codeLocation: dir('agents/my-agent') }]);

    expect(() => validateContainerAgents(spec, CONFIG_ROOT)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
