import type { TargetInfo } from '../types';
import { useTargetBasedWizard } from '../useTargetBasedWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

// ── Simple harness ─────────────────────────────────────────────────────────

function Harness() {
  const wizard = useTargetBasedWizard();
  return (
    <Text>
      step:{wizard.step}
      name:{wizard.config.name}
      description:{wizard.config.description}
      gateway:{wizard.config.gateway}
      controlWeight:{wizard.config.controlWeight}
      treatmentWeight:{wizard.config.treatmentWeight}
      enableOnCreate:{String(wizard.config.enableOnCreate)}
    </Text>
  );
}

// ── Imperative harness ─────────────────────────────────────────────────────

interface HarnessHandle {
  setName: (name: string) => void;
  setDescription: (desc: string) => void;
  advanceFromNameDescription: () => void;
  setGateway: (name: string, isNew: boolean) => void;
  advance: () => void;
  goBack: () => void;
  setControlTarget: (target: TargetInfo, isNew: boolean) => void;
  setTreatmentTarget: (target: TargetInfo, isNew: boolean) => void;
  setControlWeight: (w: number) => void;
  setControlEval: (name: string) => void;
  setTreatmentEval: (name: string) => void;
  setEnableOnCreate: (enable: boolean) => void;
  toAddABTestConfig: ReturnType<typeof useTargetBasedWizard>['toAddABTestConfig'];
}

const ImperativeHarness = React.forwardRef<HarnessHandle>((_, ref) => {
  const wizard = useTargetBasedWizard();
  useImperativeHandle(ref, () => ({
    setName: wizard.setName,
    setDescription: wizard.setDescription,
    advanceFromNameDescription: wizard.advanceFromNameDescription,
    setGateway: wizard.setGateway,
    advance: wizard.advance,
    goBack: wizard.goBack,
    setControlTarget: wizard.setControlTarget,
    setTreatmentTarget: wizard.setTreatmentTarget,
    setControlWeight: wizard.setControlWeight,
    setControlEval: wizard.setControlEval,
    setTreatmentEval: wizard.setTreatmentEval,
    setEnableOnCreate: wizard.setEnableOnCreate,
    toAddABTestConfig: wizard.toAddABTestConfig,
  }));
  const ctrlName = wizard.config.controlTargetInfo ? wizard.config.controlTargetInfo.name : 'null';
  const treatName = wizard.config.treatmentTargetInfo ? wizard.config.treatmentTargetInfo.name : 'null';
  return (
    <Text>
      {[
        `step:${wizard.step}`,
        `name:${wizard.config.name}`,
        `description:${wizard.config.description}`,
        `gateway:${wizard.config.gateway}`,
        `gatewayIsNew:${String(wizard.config.gatewayIsNew)}`,
        `controlWeight:${wizard.config.controlWeight}`,
        `treatmentWeight:${wizard.config.treatmentWeight}`,
        `controlOnlineEval:${wizard.config.controlOnlineEval}`,
        `treatmentOnlineEval:${wizard.config.treatmentOnlineEval}`,
        `enableOnCreate:${String(wizard.config.enableOnCreate)}`,
        `controlTargetInfo:${ctrlName}`,
        `treatmentTargetInfo:${treatName}`,
      ].join('|')}
    </Text>
  );
});
ImperativeHarness.displayName = 'ImperativeHarness';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useTargetBasedWizard', () => {
  describe('defaults', () => {
    it('initial step is nameDescription', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('step:nameDescription');
    });

    it('default weights are 90/10', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('controlWeight:90');
      expect(lastFrame()).toContain('treatmentWeight:10');
    });

    it('default enableOnCreate is true', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('enableOnCreate:true');
    });
  });

  describe('step navigation', () => {
    it('advanceFromNameDescription moves to gateway step', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());

      expect(lastFrame()).toContain('step:gateway');
    });

    it('advance from gateway moves to builder', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      // setGateway auto-advances to builder
      act(() => ref.current!.setGateway('my-gw', false));

      expect(lastFrame()).toContain('step:builder');
    });

    it('advance from builder moves to enableOnCreate', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('my-gw', false));
      // Now at builder, advance to enableOnCreate
      act(() => ref.current!.advance());

      expect(lastFrame()).toContain('step:enableOnCreate');
    });

    it('advance from enableOnCreate moves to confirm', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('my-gw', false));
      act(() => ref.current!.advance()); // builder → enableOnCreate
      act(() => ref.current!.setEnableOnCreate(true)); // enableOnCreate → confirm

      expect(lastFrame()).toContain('step:confirm');
    });
  });

  describe('goBack', () => {
    it('goBack from gateway goes to nameDescription', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      expect(lastFrame()).toContain('step:gateway');

      act(() => ref.current!.goBack());
      expect(lastFrame()).toContain('step:nameDescription');
    });

    it('goBack from builder goes to gateway', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('my-gw', false));
      expect(lastFrame()).toContain('step:builder');

      act(() => ref.current!.goBack());
      expect(lastFrame()).toContain('step:gateway');
    });
  });

  describe('config updates', () => {
    it('setName updates config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('MyTest'));

      expect(lastFrame()).toContain('name:MyTest');
    });

    it('setDescription updates config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setDescription('desc1'));

      expect(lastFrame()).toContain('description:desc1');
    });

    it('setGateway updates config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('gw-123', true));

      expect(lastFrame()).toContain('gateway:gw-123');
      expect(lastFrame()).toContain('gatewayIsNew:true');
    });

    it('setControlTarget updates config with targetInfo', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      const target: TargetInfo = { name: 'ctrl-target', runtimeRef: 'arn:runtime:1', qualifier: 'DEFAULT' };
      act(() => ref.current!.setControlTarget(target, false));

      expect(lastFrame()).toContain('controlTargetInfo:ctrl-target');
    });

    it('setTreatmentTarget updates config with targetInfo', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      const target: TargetInfo = { name: 'tt1', runtimeRef: 'arn:runtime:2', qualifier: 'v2' };
      act(() => ref.current!.setTreatmentTarget(target, true));

      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).toContain('treatmentTargetInfo:tt1');
    });

    it('setControlWeight updates config (sum to 100)', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setControlWeight(70));

      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).toContain('controlWeight:70');
      expect(frame).toContain('treatmentWeight:30');
    });

    it('setControlEval updates config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setControlEval('eval-arn-1'));

      expect(lastFrame()).toContain('controlOnlineEval:eval-arn-1');
    });

    it('setTreatmentEval updates config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setTreatmentEval('eval-arn-2'));

      expect(lastFrame()).toContain('treatmentOnlineEval:eval-arn-2');
    });
  });

  describe('toAddABTestConfig', () => {
    it('returns correct AddABTestConfig shape', () => {
      const ref = React.createRef<HarnessHandle>();
      render(<ImperativeHarness ref={ref} />);

      const controlTarget: TargetInfo = { name: 'ctrl', runtimeRef: 'arn:runtime:1', qualifier: 'DEFAULT' };
      const treatmentTarget: TargetInfo = { name: 'treat', runtimeRef: 'arn:runtime:2', qualifier: 'v2' };

      act(() => ref.current!.setName('TestAB'));
      act(() => ref.current!.setDescription('A/B test'));
      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('my-gateway', false));
      act(() => ref.current!.setControlTarget(controlTarget, false));
      act(() => ref.current!.setTreatmentTarget(treatmentTarget, true));
      act(() => ref.current!.setControlWeight(80));
      act(() => ref.current!.setControlEval('eval-1'));
      act(() => ref.current!.setTreatmentEval('eval-2'));

      let config: ReturnType<HarnessHandle['toAddABTestConfig']> | undefined;
      act(() => {
        config = ref.current!.toAddABTestConfig();
      });

      expect(config).toBeDefined();
      expect(config!.mode).toBe('target-based');
      expect(config!.name).toBe('TestAB');
      expect(config!.description).toBe('A/B test');
      expect(config!.gateway).toBe('my-gateway');
      expect(config!.gatewayIsNew).toBe(false);
      expect(config!.gatewayChoice).toEqual({ type: 'existing-http', name: 'my-gateway' });
      expect(config!.controlTargetInfo).toEqual(controlTarget);
      expect(config!.controlTargetIsNew).toBe(false);
      expect(config!.treatmentTargetInfo).toEqual(treatmentTarget);
      expect(config!.treatmentTargetIsNew).toBe(true);
      expect(config!.controlWeight).toBe(80);
      expect(config!.treatmentWeight).toBe(20);
      expect(config!.controlOnlineEval).toBe('eval-1');
      expect(config!.treatmentOnlineEval).toBe('eval-2');
      expect(config!.runtime).toBe('arn:runtime:1');
      expect(config!.controlTarget).toBe('ctrl');
      expect(config!.controlEndpoint).toBe('DEFAULT');
      expect(config!.treatmentTarget).toBe('treat');
      expect(config!.treatmentEndpoint).toBe('v2');
      expect(config!.enableOnCreate).toBe(true);
      expect(config!.evaluators).toEqual([]);
      expect(config!.samplingRate).toBe(10);
    });

    it('returns create-new gatewayChoice when gatewayIsNew is true', () => {
      const ref = React.createRef<HarnessHandle>();
      render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.advanceFromNameDescription());
      act(() => ref.current!.setGateway('new-gw', true));

      let config: ReturnType<HarnessHandle['toAddABTestConfig']> | undefined;
      act(() => {
        config = ref.current!.toAddABTestConfig();
      });

      expect(config!.gatewayChoice).toEqual({ type: 'create-new' });
    });
  });
});
