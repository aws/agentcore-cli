import type { DeployedState, HarnessDeployedState } from '../../../schema';
import { toPascalId } from '../logical-ids';
import { buildDeployedState, parseHarnessOutputs } from '../outputs';
import { describe, expect, it, vi } from 'vitest';

/** Silent onWarn sink for cases where the warning is not under test. */
const noWarn = vi.fn();

/** Build the four CDK output keys for a harness, mirroring the L3's output naming. */
function harnessOutputs(
  name: string,
  overrides: Partial<Record<'Id' | 'Arn' | 'Status' | 'RoleRoleArn' | 'AgentRuntimeArn', string>> = {}
) {
  const p = toPascalId('Harness', name);
  const out: Record<string, string> = {};
  const def = {
    Id: `h-${name}`,
    Arn: `arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-${name}`,
    Status: 'READY',
    RoleRoleArn: `arn:aws:iam::111122223333:role/${name}`,
    AgentRuntimeArn: `arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/rt-${name}`,
  };
  const merged = { ...def, ...overrides };
  for (const [seg, val] of Object.entries(merged)) {
    if (val === undefined) continue;
    out[`Application${p}${seg}Output${seg}Hash`] = val;
  }
  return out;
}

describe('parseHarnessOutputs', () => {
  it('parses a complete harness into a cloudformation-marked record', () => {
    const result = parseHarnessOutputs(harnessOutputs('h1'), ['h1'], noWarn);
    expect(result.h1).toMatchObject({
      harnessId: 'h-h1',
      status: 'READY',
      provisioner: 'cloudformation',
    });
    expect(result.h1!.agentRuntimeArn).toContain('runtime/rt-h1');
  });

  it('warns and skips when a harness produced no outputs', () => {
    const onWarn = vi.fn();
    const result = parseHarnessOutputs({}, ['ghost'], onWarn);
    expect(result.ghost).toBeUndefined();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('produced no CloudFormation outputs');
  });

  it('warns naming the missing key when a harness is partially emitted', () => {
    const onWarn = vi.fn();
    // Drop the RoleRoleArn output → partial.
    const outputs = harnessOutputs('h1', { RoleRoleArn: undefined });
    const result = parseHarnessOutputs(outputs, ['h1'], onWarn);
    expect(result.h1).toBeUndefined();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('RoleArn');
  });

  it('defaults onWarn to console.warn without throwing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseHarnessOutputs({}, ['ghost']);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('buildDeployedState — harness carry-forward', () => {
  const orphan: HarnessDeployedState = {
    harnessId: 'h-orphan',
    harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-orphan',
    roleArn: 'arn:aws:iam::111122223333:role/orphan',
    status: 'READY',
    // no provisioner marker → orphan
  };
  const markedExisting: HarnessDeployedState = {
    harnessId: 'h-old-cfn',
    harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-old-cfn',
    roleArn: 'arn:aws:iam::111122223333:role/oldcfn',
    status: 'READY',
    provisioner: 'cloudformation',
  };

  function existingStateWith(harnesses: Record<string, HarnessDeployedState>): DeployedState {
    return { targets: { default: { resources: { stackName: 'S', harnesses } } } };
  }

  it('preserves an existing orphan that the current outputs do not cover', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'S',
      agents: {},
      gateways: {},
      existingState: existingStateWith({ legacy: orphan }),
      harnesses: parseHarnessOutputs(harnessOutputs('h1'), ['h1'], noWarn),
    });
    const harnesses = result.targets.default!.resources?.harnesses ?? {};
    expect(harnesses.legacy).toMatchObject({ harnessId: 'h-orphan' });
    expect(harnesses.h1).toMatchObject({ provisioner: 'cloudformation' });
  });

  it('lets a freshly-parsed CFN record win on key conflict (carries the marker)', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'S',
      agents: {},
      gateways: {},
      existingState: existingStateWith({ h1: orphan }),
      harnesses: parseHarnessOutputs(harnessOutputs('h1'), ['h1'], noWarn),
    });
    const h1 = result.targets.default!.resources?.harnesses?.h1;
    expect(h1?.provisioner).toBe('cloudformation');
    expect(h1?.harnessId).toBe('h-h1');
  });

  it('drops a previously CFN-managed harness that is no longer in the outputs (CFN deleted it)', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'S',
      agents: {},
      gateways: {},
      existingState: existingStateWith({ removed: markedExisting }),
      harnesses: {},
    });
    expect(result.targets.default!.resources?.harnesses).toBeUndefined();
  });

  it('does not create a harnesses key when there are neither outputs nor existing orphans', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'S',
      agents: {},
      gateways: {},
      harnesses: {},
    });
    expect(result.targets.default!.resources?.harnesses).toBeUndefined();
  });
});
