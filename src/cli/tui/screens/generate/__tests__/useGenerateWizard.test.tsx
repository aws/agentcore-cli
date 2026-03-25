import { useGenerateWizard } from '../useGenerateWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Imperative harness — exposes wizard methods via ref for act()-based tests
// ---------------------------------------------------------------------------

type WizardReturn = ReturnType<typeof useGenerateWizard>;

interface HarnessHandle {
  wizard: WizardReturn;
}

const Harness = React.forwardRef<HarnessHandle, { initialName?: string }>((props, ref) => {
  const wizard = useGenerateWizard(props.initialName ? { initialName: props.initialName } : undefined);
  useImperativeHandle(ref, () => ({ wizard }));
  return (
    <Text>
      step:{wizard.step} steps:{wizard.steps.join(',')} networkMode:{wizard.config.networkMode ?? 'undefined'}{' '}
      advancedSelected:{String(wizard.advancedSelected)}
    </Text>
  );
});
Harness.displayName = 'Harness';

function setup(initialName?: string) {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} initialName={initialName} />);
  return { ref, ...result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGenerateWizard — advanced config gate', () => {
  describe('step list includes advanced', () => {
    it('BASE steps include advanced before confirm', () => {
      const { lastFrame } = setup();
      const frame = lastFrame()!;
      expect(frame).toContain('steps:');
      // Default modelProvider is Bedrock which filters out apiKey
      // authorizerType is only shown when advanced is selected
      expect(frame).toMatch(/modelProvider,advanced,confirm/);
      expect(frame).not.toContain('apiKey');
    });

    it('MCP protocol skips sdk/modelProvider/apiKey but keeps advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('MCP');
      });
      const frame = lastFrame()!;
      expect(frame).toContain('advanced');
      expect(frame).not.toMatch(/steps:[^]*sdk/);
      expect(frame).not.toMatch(/steps:[^]*modelProvider/);
    });

    it('Strands SDK inserts memory before advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
      });
      const frame = lastFrame()!;
      expect(frame).toMatch(/memory,advanced/);
    });
  });

  describe('setAdvanced routing', () => {
    function walkToAdvanced(ref: React.RefObject<HarnessHandle | null>) {
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
      });
    }

    it('setAdvanced(false) jumps to confirm with PUBLIC defaults', () => {
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);
      expect(lastFrame()).toContain('step:advanced');

      act(() => ref.current!.wizard.setAdvanced(false));

      const frame = lastFrame()!;
      expect(frame).toContain('step:confirm');
      expect(frame).toContain('networkMode:PUBLIC');
      expect(frame).toContain('advancedSelected:false');
    });

    it('setAdvanced(true) navigates to networkMode', () => {
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(true));

      const frame = lastFrame()!;
      expect(frame).toContain('step:networkMode');
      expect(frame).toContain('advancedSelected:true');
    });

    it('setAdvanced(true) injects networkMode and requestHeaderAllowlist into steps', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(true));

      const steps = ref.current!.wizard.steps;
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual([
        'advanced',
        'networkMode',
        'requestHeaderAllowlist',
        'authorizerType',
        'confirm',
      ]);
    });

    it('setAdvanced(true) then VPC injects subnets and securityGroups', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(true));
      act(() => ref.current!.wizard.setNetworkMode('VPC'));

      const steps = ref.current!.wizard.steps;
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual([
        'advanced',
        'networkMode',
        'subnets',
        'securityGroups',
        'requestHeaderAllowlist',
        'authorizerType',
        'confirm',
      ]);
    });
  });

  describe('state cleanup on toggle', () => {
    function walkToAdvancedAndSelectYes(ref: React.RefObject<HarnessHandle | null>) {
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
      });
      act(() => ref.current!.wizard.setAdvanced(true));
      act(() => ref.current!.wizard.setNetworkMode('VPC'));
      act(() => ref.current!.wizard.setSubnets(['subnet-123']));
      act(() => ref.current!.wizard.setSecurityGroups(['sg-456']));
    }

    it('switching from Yes to No clears VPC config', () => {
      const { ref } = setup();
      walkToAdvancedAndSelectYes(ref);

      // Now go back and select No
      act(() => ref.current!.wizard.setAdvanced(false));

      const w = ref.current!.wizard;
      expect(w.step).toBe('confirm');
      expect(w.config.networkMode).toBe('PUBLIC');
      expect(w.advancedSelected).toBe(false);
      // Network steps should not be in the step list
      expect(w.steps).not.toContain('subnets');
      expect(w.steps).not.toContain('securityGroups');
      expect(w.steps).not.toContain('networkMode');
    });

    it('config subnets and securityGroups are cleared to undefined', () => {
      const { ref } = setup();
      walkToAdvancedAndSelectYes(ref);

      act(() => ref.current!.wizard.setAdvanced(false));

      expect(ref.current!.wizard.config.subnets).toBeUndefined();
      expect(ref.current!.wizard.config.securityGroups).toBeUndefined();
      expect(ref.current!.wizard.config.networkMode).toBe('PUBLIC');
    });
  });

  describe('routing callbacks target advanced', () => {
    it('setProtocol(MCP) routes to advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('MCP');
      });
      expect(lastFrame()).toContain('step:advanced');
    });

    it('setModelProvider(Bedrock) with non-Strands routes to advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('LangChain_LangGraph');
      });
      // Separate act() so setModelProvider picks up the new config.sdk
      act(() => ref.current!.wizard.setModelProvider('Bedrock'));
      expect(lastFrame()).toContain('step:advanced');
    });

    it('setApiKey with non-Strands routes to advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('LangChain_LangGraph');
      });
      // Separate act() calls so callbacks pick up the new config.sdk
      act(() => ref.current!.wizard.setModelProvider('OpenAI'));
      act(() => ref.current!.wizard.setApiKey('sk-test'));
      expect(lastFrame()).toContain('step:advanced');
    });

    it('skipApiKey with non-Strands routes to advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('LangChain_LangGraph');
      });
      // Separate act() calls so callbacks pick up the new config.sdk
      act(() => ref.current!.wizard.setModelProvider('OpenAI'));
      act(() => ref.current!.wizard.skipApiKey());
      expect(lastFrame()).toContain('step:advanced');
    });

    it('setMemory routes to advanced', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('shortTerm');
      });
      expect(lastFrame()).toContain('step:advanced');
    });
  });

  describe('reset clears advancedSelected', () => {
    it('reset returns advancedSelected to false', () => {
      const { ref, lastFrame } = setup();
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
        ref.current!.wizard.setAdvanced(true);
      });
      expect(lastFrame()).toContain('advancedSelected:true');

      act(() => ref.current!.wizard.reset());

      expect(lastFrame()).toContain('advancedSelected:false');
    });
  });
});
