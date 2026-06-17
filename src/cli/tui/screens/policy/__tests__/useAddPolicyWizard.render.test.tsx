// Render-level tests for the add-policy wizard hook. These mount the real hook
// and assert its live step state — specifically that with no deployed gateways
// the wizard opens on a usable step (never the "No deployed gateways" dead-end)
// and can advance through the policy steps without ever hitting gateway/target.
import type { AddPolicyStep } from '../types';
import { useAddPolicyWizard } from '../useAddPolicyWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

type WizardReturn = ReturnType<typeof useAddPolicyWizard>;

interface HarnessHandle {
  wizard: WizardReturn;
}

interface HarnessProps {
  preSelectedEngine?: string;
  hasDeployedGateways: boolean;
}

const Harness = React.forwardRef<HarnessHandle, HarnessProps>(({ preSelectedEngine, hasDeployedGateways }, ref) => {
  const wizard = useAddPolicyWizard(preSelectedEngine, hasDeployedGateways);
  useImperativeHandle(ref, () => ({ wizard }), [wizard]);
  return (
    <Text>
      step:{wizard.step} steps:{wizard.steps.join(',')}
    </Text>
  );
});
Harness.displayName = 'Harness';

function mount(props: HarnessProps) {
  const ref = React.createRef<HarnessHandle>();
  const { lastFrame } = render(<Harness ref={ref} {...props} />);
  return { ref, lastFrame };
}

describe('useAddPolicyWizard — gateway/target skipping', () => {
  it('opens on a non-gateway step when no gateway is deployed', () => {
    const { ref, lastFrame } = mount({ hasDeployedGateways: false });
    // Must NOT open on the gateway step (the dead-end when nothing is deployed).
    expect(ref.current!.wizard.step).not.toBe('gateway');
    expect(ref.current!.wizard.step).toBe('engine');
    expect(ref.current!.wizard.steps).not.toContain('gateway');
    expect(ref.current!.wizard.steps).not.toContain('target');
    expect(lastFrame()).toContain('step:engine');
  });

  it('opens on the gateway step when a gateway is deployed', () => {
    const { ref } = mount({ hasDeployedGateways: true });
    expect(ref.current!.wizard.step).toBe('gateway');
    expect(ref.current!.wizard.steps).toContain('gateway');
    expect(ref.current!.wizard.steps).toContain('target');
  });

  it('advances engine -> name -> source-method without touching gateway/target when none deployed', () => {
    const { ref } = mount({ hasDeployedGateways: false });
    expect(ref.current!.wizard.step).toBe('engine');

    act(() => ref.current!.wizard.setEngine('eng'));
    expect(ref.current!.wizard.step).toBe('name');

    act(() => ref.current!.wizard.setName('p1'));
    expect(ref.current!.wizard.step).toBe('source-method');

    // Picking the inline source advances into its step — no gateway prompt in between.
    act(() => ref.current!.wizard.setSourceMethod('inline'));
    expect(ref.current!.wizard.step).toBe('source-inline');

    const seen: AddPolicyStep[] = ref.current!.wizard.steps;
    expect(seen).not.toContain('gateway');
    expect(seen).not.toContain('target');
  });
});
