import type { AgentCoreProjectSpec } from '../../../../schema';
import { computeDeployAttrs } from '../utils.js';
import { describe, expect, it } from 'vitest';

describe('computeDeployAttrs', () => {
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
      memory_count: 1,
      credential_count: 3,
      evaluator_count: 1,
      online_eval_count: 2,
      gateway_count: 2,
      gateway_target_count: 3,
      policy_engine_count: 2,
      policy_count: 3,
      mode: 'diff',
    });
  });

  it('returns zeros for empty spec', () => {
    expect(computeDeployAttrs({}, 'deploy')).toEqual({
      runtime_count: 0,
      memory_count: 0,
      credential_count: 0,
      evaluator_count: 0,
      online_eval_count: 0,
      gateway_count: 0,
      gateway_target_count: 0,
      policy_engine_count: 0,
      policy_count: 0,
      mode: 'deploy',
    });
  });

  it('handles dry-run mode', () => {
    const projectSpec = { runtimes: [{}] } as unknown as Partial<AgentCoreProjectSpec>;
    const attrs = computeDeployAttrs(projectSpec, 'dry-run');

    expect(attrs.runtime_count).toBe(1);
    expect(attrs.memory_count).toBe(0);
    expect(attrs.mode).toBe('dry-run');
  });
});
