import type { AgentCoreProjectSpec } from '../../../../schema';
import { PERMISSIONS_BOUNDARY_ENV_VAR } from '../../../constants';
import { computeDeployAttrs } from '../utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the boundary attribute independent of whatever ~/.agentcore/config.json holds locally.
const { readGlobalConfigSyncMock } = vi.hoisted(() => ({
  readGlobalConfigSyncMock: vi.fn(() => ({})),
}));

vi.mock('../../../../lib/schemas/io/global-config', () => ({
  readGlobalConfigSync: readGlobalConfigSyncMock,
}));

describe('computeDeployAttrs', () => {
  const savedBoundaryEnv = process.env[PERMISSIONS_BOUNDARY_ENV_VAR];

  beforeEach(() => {
    // The boundary attribute reads the environment; keep it out of the assertions below.
    delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
    readGlobalConfigSyncMock.mockReturnValue({});
  });

  afterEach(() => {
    if (savedBoundaryEnv === undefined) {
      delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
    } else {
      process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = savedBoundaryEnv;
    }
  });

  it('computes counts from a populated spec', () => {
    const projectSpec = {
      runtimes: [{}, {}],
      memories: [{}],
      credentials: [{}, {}, {}],
      evaluators: [{}],
      onlineEvalConfigs: [{}, {}],
      agentCoreGateways: [{ targets: [{}, {}] }, { targets: [{}] }],
      policyEngines: [{ policies: [{}, {}] }, { policies: [{}] }],
    } as unknown as Partial<AgentCoreProjectSpec>;

    expect(computeDeployAttrs(projectSpec, 'diff')).toEqual({
      runtime_count: 2,
      harness_count: 0,
      memory_count: 1,
      credential_count: 3,
      evaluator_count: 1,
      online_eval_count: 2,
      gateway_count: 2,
      gateway_target_count: 3,
      policy_engine_count: 2,
      policy_count: 3,
      deploy_mode: 'diff',
      permissions_boundary: false,
    });
  });

  it('flags an explicitly configured permissions boundary', () => {
    const projectSpec = {
      iam: { permissionsBoundary: 'AgentCoreExecutionRoleBoundary' },
    } as unknown as Partial<AgentCoreProjectSpec>;

    expect(computeDeployAttrs(projectSpec, 'deploy').permissions_boundary).toBe(true);
  });

  it('flags a boundary that comes from the machine global config', () => {
    readGlobalConfigSyncMock.mockReturnValue({ permissionsBoundary: 'AgentCoreExecutionRoleBoundary' });

    expect(computeDeployAttrs({}, 'deploy').permissions_boundary).toBe(true);
  });

  it('returns zeros for empty spec', () => {
    expect(computeDeployAttrs({}, 'deploy')).toEqual({
      runtime_count: 0,
      harness_count: 0,
      memory_count: 0,
      credential_count: 0,
      evaluator_count: 0,
      online_eval_count: 0,
      gateway_count: 0,
      gateway_target_count: 0,
      policy_engine_count: 0,
      policy_count: 0,
      deploy_mode: 'deploy',
      permissions_boundary: false,
    });
  });

  it('handles dry-run mode', () => {
    const projectSpec = { runtimes: [{}] } as unknown as Partial<AgentCoreProjectSpec>;
    const attrs = computeDeployAttrs(projectSpec, 'dry-run');

    expect(attrs.runtime_count).toBe(1);
    expect(attrs.memory_count).toBe(0);
    expect(attrs.deploy_mode).toBe('dry-run');
  });
});
