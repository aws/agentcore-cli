import { getAllSteps } from '../useAddOnlineEvalWizard';
import { describe, expect, it } from 'vitest';

describe('getAllSteps (online-eval add wizard)', () => {
  it('omits the agent step when there is at most 1 agent', () => {
    expect(getAllSteps(0)).toEqual([
      'name',
      'endpoint',
      'evaluators',
      'samplingRate',
      'sessionTimeout',
      'filters',
      'enableOnCreate',
      'confirm',
    ]);
    expect(getAllSteps(1)).toEqual([
      'name',
      'endpoint',
      'evaluators',
      'samplingRate',
      'sessionTimeout',
      'filters',
      'enableOnCreate',
      'confirm',
    ]);
  });

  it('includes the agent step when there are 2+ agents', () => {
    expect(getAllSteps(3)).toEqual([
      'name',
      'agent',
      'endpoint',
      'evaluators',
      'samplingRate',
      'sessionTimeout',
      'filters',
      'enableOnCreate',
      'confirm',
    ]);
  });

  it('places sessionTimeout and filters between samplingRate and enableOnCreate', () => {
    const steps = getAllSteps(2);
    const samplingIdx = steps.indexOf('samplingRate');
    const sessionIdx = steps.indexOf('sessionTimeout');
    const filtersIdx = steps.indexOf('filters');
    const enableIdx = steps.indexOf('enableOnCreate');
    expect(samplingIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBe(samplingIdx + 1);
    expect(filtersIdx).toBe(sessionIdx + 1);
    expect(enableIdx).toBe(filtersIdx + 1);
  });
});
