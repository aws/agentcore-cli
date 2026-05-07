import type { AgentCoreProjectSpec, DirectoryPath, FilePath } from '../../../../schema';
import { computeTargetPort, isPortExplicit, resolveDevPort } from '../port-resolution';
import { describe, expect, it, vi } from 'vitest';

// Helper to cast strings to branded path types for testing
const filePath = (s: string) => s as FilePath;
const dirPath = (s: string) => s as DirectoryPath;

const makeProject = (...names: string[]): AgentCoreProjectSpec => ({
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: names.map(name => ({
    name,
    build: 'CodeZip' as const,
    runtimeVersion: 'PYTHON_3_12' as const,
    entrypoint: filePath('main.py'),
    codeLocation: dirPath(`./agents/${name}`),
    protocol: 'HTTP' as const,
  })),
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  abTests: [],
  httpGateways: [],
});

describe('isPortExplicit', () => {
  it('returns true when source is "cli"', () => {
    const cmd = { getOptionValueSource: vi.fn(() => 'cli' as const) };
    expect(isPortExplicit(cmd)).toBe(true);
    expect(cmd.getOptionValueSource).toHaveBeenCalledWith('port');
  });

  it('returns true when source is "env" (any non-default counts)', () => {
    const cmd = { getOptionValueSource: vi.fn(() => 'env' as const) };
    expect(isPortExplicit(cmd)).toBe(true);
  });

  it('returns true when source is "config"', () => {
    const cmd = { getOptionValueSource: vi.fn(() => 'config' as const) };
    expect(isPortExplicit(cmd)).toBe(true);
  });

  it('returns false when source is "default"', () => {
    const cmd = { getOptionValueSource: vi.fn(() => 'default' as const) };
    expect(isPortExplicit(cmd)).toBe(false);
  });

  it('returns false and warns when command is undefined', () => {
    const onWarn = vi.fn();
    expect(isPortExplicit(undefined, onWarn)).toBe(false);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/getOptionValueSource unavailable/);
  });

  it('returns false and warns when getOptionValueSource is missing', () => {
    const onWarn = vi.fn();
    // Simulate a future Commander upgrade dropping the API.
    const cmd = {} as unknown as { getOptionValueSource: () => string };
    expect(isPortExplicit(cmd, onWarn)).toBe(false);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/getOptionValueSource unavailable/);
  });

  it('uses console.warn by default when onWarn omitted and API missing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(isPortExplicit(undefined)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveDevPort - HTTP protocol', () => {
  it('issue #1079: explicit --port 8080 (matching default) honors literally for runtime at index 1', () => {
    const project = makeProject('AgentA', 'AgentB');
    // No conflict: availablePort matches the literal explicit port.
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'HTTP',
      basePort: 8080,
      portIsExplicit: true,
      availablePort: 8080,
    });
    expect(r.port).toBe(8080);
    expect(r.offset).toBe(0);
    expect(r.conflictError).toBeUndefined();
    expect(r.infoLogs).toEqual([]);
  });

  it('issue #1079: implicit --port (default) auto-offsets and emits an "index" log', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'HTTP',
      basePort: 8080,
      portIsExplicit: false,
      availablePort: 8081,
    });
    expect(r.port).toBe(8081);
    expect(r.offset).toBe(1);
    expect(r.conflictError).toBeUndefined();
    expect(r.infoLogs.some(l => l.includes('AgentB') && l.includes('index 1') && l.includes('8081'))).toBe(true);
    expect(r.infoLogs.some(l => l.includes('pass --port 8081 explicitly to override'))).toBe(true);
  });

  it('issue #1079: explicit --port + conflict yields a conflictError instead of silent shift', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'HTTP',
      basePort: 8788,
      portIsExplicit: true,
      availablePort: 8793, // simulate conflict — findAvailablePort shifted
    });
    expect(r.conflictError).toBeDefined();
    expect(r.conflictError).toMatch(/8788.*in use/);
    expect(r.conflictError).toMatch(/Pass a different --port or stop the conflicting process/);
  });

  it('implicit --port + conflict silently shifts and emits "Port X in use, using Y"', () => {
    const project = makeProject('AgentA');
    const r = resolveDevPort({
      project,
      agentName: 'AgentA',
      protocol: 'HTTP',
      basePort: 8080,
      portIsExplicit: false,
      availablePort: 8085, // findAvailablePort shifted
    });
    expect(r.port).toBe(8085);
    expect(r.conflictError).toBeUndefined();
    expect(r.infoLogs.some(l => l.includes('Port 8080 in use, using 8085'))).toBe(true);
  });

  it('first runtime (index 0) emits no offset log even with implicit port', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentA',
      protocol: 'HTTP',
      basePort: 8080,
      portIsExplicit: false,
      availablePort: 8080,
    });
    expect(r.offset).toBe(0);
    expect(r.infoLogs).toEqual([]);
  });
});

describe('resolveDevPort - A2A/MCP protocols', () => {
  it('A2A: ignores basePort/offset and uses 9000', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'A2A',
      basePort: 8080,
      portIsExplicit: false,
      availablePort: 9000,
    });
    expect(r.port).toBe(9000);
    // No "index N" log even though AgentB is at index 1 — A2A is gated out.
    expect(r.infoLogs.every(l => !l.includes('index'))).toBe(true);
  });

  it('A2A: conflict yields A2A-specific message, not the HTTP one', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'A2A',
      basePort: 8080,
      portIsExplicit: true, // explicit flag must NOT trigger the HTTP branch
      availablePort: 9001, // conflict
    });
    expect(r.conflictError).toBeDefined();
    expect(r.conflictError).toMatch(/A2A agents require port 9000/);
    expect(r.conflictError).not.toMatch(/Pass a different --port/);
  });

  it('MCP: ignores basePort/offset and uses 8000', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'MCP',
      basePort: 8080,
      portIsExplicit: false,
      availablePort: 8000,
    });
    expect(r.port).toBe(8000);
    expect(r.infoLogs.every(l => !l.includes('index'))).toBe(true);
  });

  it('MCP: conflict yields MCP-specific message, not the HTTP one', () => {
    const project = makeProject('AgentA', 'AgentB');
    const r = resolveDevPort({
      project,
      agentName: 'AgentB',
      protocol: 'MCP',
      basePort: 8080,
      portIsExplicit: true,
      availablePort: 8001,
    });
    expect(r.conflictError).toBeDefined();
    expect(r.conflictError).toMatch(/MCP agents require port 8000/);
    expect(r.conflictError).not.toMatch(/Pass a different --port/);
  });
});

describe('computeTargetPort', () => {
  it('agrees with resolveDevPort on targetPort for HTTP+implicit', () => {
    const project = makeProject('AgentA', 'AgentB');
    const args = {
      project,
      agentName: 'AgentB',
      protocol: 'HTTP' as const,
      basePort: 8080,
      portIsExplicit: false,
    };
    const target = computeTargetPort(args);
    const resolved = resolveDevPort({ ...args, availablePort: target.targetPort });
    expect(resolved.port).toBe(target.targetPort);
    expect(resolved.offset).toBe(target.offset);
  });

  it('agrees with resolveDevPort on targetPort for HTTP+explicit', () => {
    const project = makeProject('AgentA', 'AgentB');
    const args = {
      project,
      agentName: 'AgentB',
      protocol: 'HTTP' as const,
      basePort: 8788,
      portIsExplicit: true,
    };
    const target = computeTargetPort(args);
    expect(target.targetPort).toBe(8788);
    expect(target.offset).toBe(0);
  });

  it('A2A always returns 9000 regardless of basePort', () => {
    const project = makeProject('AgentA', 'AgentB');
    const target = computeTargetPort({
      project,
      agentName: 'AgentB',
      protocol: 'A2A',
      basePort: 8080,
      portIsExplicit: true,
    });
    expect(target.targetPort).toBe(9000);
    expect(target.offset).toBe(0);
    expect(target.infoLogs.every(l => !l.includes('index'))).toBe(true);
  });

  it('MCP always returns 8000 regardless of basePort', () => {
    const project = makeProject('AgentA');
    const target = computeTargetPort({
      project,
      agentName: 'AgentA',
      protocol: 'MCP',
      basePort: 9999,
      portIsExplicit: false,
    });
    expect(target.targetPort).toBe(8000);
    expect(target.offset).toBe(0);
  });

  it('emits offset log when HTTP runtime is at index > 0 and port is implicit', () => {
    const project = makeProject('AgentA', 'AgentB', 'AgentC');
    const target = computeTargetPort({
      project,
      agentName: 'AgentC',
      protocol: 'HTTP',
      basePort: 8080,
      portIsExplicit: false,
    });
    expect(target.targetPort).toBe(8082);
    expect(target.offset).toBe(2);
    expect(target.infoLogs.some(l => l.includes('AgentC') && l.includes('index 2'))).toBe(true);
  });
});
