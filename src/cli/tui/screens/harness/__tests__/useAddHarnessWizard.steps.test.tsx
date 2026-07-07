import type { ContainerMode } from '../types';
import { useAddHarnessWizard } from '../useAddHarnessWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Imperative harness — exposes wizard methods via ref for act()-based tests
// ---------------------------------------------------------------------------

type WizardReturn = ReturnType<typeof useAddHarnessWizard>;

interface HarnessHandle {
  wizard: WizardReturn;
}

const Harness = React.forwardRef<HarnessHandle>((_props, ref) => {
  const wizard = useAddHarnessWizard();
  useImperativeHandle(ref, () => ({ wizard }));
  return <Text>step:{wizard.step}</Text>;
});
Harness.displayName = 'Harness';

function setup() {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} />);
  return { ref, ...result };
}

/**
 * Drive the bedrock harness wizard up to the network step with a given container mode and network mode.
 * bedrock flow: name → model-provider → api-format → container → memory-mode → advanced → network-mode.
 */
function walkToNetwork(
  ref: React.RefObject<HarnessHandle | null>,
  containerMode: ContainerMode,
  networkMode: 'PUBLIC' | 'VPC'
) {
  act(() => ref.current!.wizard.setName('my-harness'));
  act(() => ref.current!.wizard.setModelProvider('bedrock'));
  act(() => ref.current!.wizard.setApiFormat('converse_stream'));
  act(() => ref.current!.wizard.setContainerMode(containerMode));
  if (containerMode === 'uri') {
    act(() => ref.current!.wizard.setContainerUri('123.dkr.ecr.us-west-2.amazonaws.com/img:latest'));
  } else if (containerMode === 'dockerfile') {
    act(() => ref.current!.wizard.setDockerfilePath('Dockerfile'));
  }
  act(() => ref.current!.wizard.setMemoryMode('disabled'));
  act(() => ref.current!.wizard.setAdvancedSettings(['network']));
  act(() => ref.current!.wizard.setNetworkMode(networkMode));
}

describe('useAddHarnessWizard — vpc-id step (dockerfile + VPC)', () => {
  it('dockerfile + VPC: steps include vpc-id immediately after security-groups', () => {
    const { ref } = setup();
    walkToNetwork(ref, 'dockerfile', 'VPC');

    const steps = ref.current!.wizard.steps;
    expect(steps).toContain('vpc-id');
    const sgIdx = steps.indexOf('security-groups');
    expect(steps[sgIdx + 1]).toBe('vpc-id');
  });

  it('dockerfile + VPC: setVpcId persists into config and advances off the vpc-id step', () => {
    const { ref } = setup();
    walkToNetwork(ref, 'dockerfile', 'VPC');

    act(() => ref.current!.wizard.setSubnets('subnet-0123456789abcdef0'));
    act(() => ref.current!.wizard.setSecurityGroups('sg-0123456789abcdef0'));
    expect(ref.current!.wizard.step).toBe('vpc-id');

    act(() => ref.current!.wizard.setVpcId('vpc-0123456789abcdef0'));
    expect(ref.current!.wizard.config.vpcId).toBe('vpc-0123456789abcdef0');
    expect(ref.current!.wizard.step).not.toBe('vpc-id');
  });

  it('prebuilt containerUri + VPC: steps do NOT include vpc-id', () => {
    const { ref } = setup();
    walkToNetwork(ref, 'uri', 'VPC');

    const steps = ref.current!.wizard.steps;
    expect(steps).toContain('subnets');
    expect(steps).toContain('security-groups');
    expect(steps).not.toContain('vpc-id');
  });

  it('default environment (none) + VPC: steps do NOT include vpc-id', () => {
    const { ref } = setup();
    walkToNetwork(ref, 'none', 'VPC');

    const steps = ref.current!.wizard.steps;
    expect(steps).toContain('subnets');
    expect(steps).toContain('security-groups');
    expect(steps).not.toContain('vpc-id');
  });

  it('dockerfile + PUBLIC: steps do NOT include vpc-id (or subnets/security-groups)', () => {
    const { ref } = setup();
    walkToNetwork(ref, 'dockerfile', 'PUBLIC');

    const steps = ref.current!.wizard.steps;
    expect(steps).not.toContain('vpc-id');
    expect(steps).not.toContain('subnets');
    expect(steps).not.toContain('security-groups');
  });
});
