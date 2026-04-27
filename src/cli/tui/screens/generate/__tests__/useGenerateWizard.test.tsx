import { validateDockerfileInput } from '../types';
import { useGenerateWizard } from '../useGenerateWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
      advancedSelected:{String(wizard.advancedSelected)} dockerfile:{wizard.config.dockerfile ?? 'undefined'}
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

    it('setAdvanced([]) jumps to confirm with PUBLIC defaults', () => {
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);
      expect(lastFrame()).toContain('step:advanced');

      act(() => ref.current!.wizard.setAdvanced([]));

      const frame = lastFrame()!;
      expect(frame).toContain('step:confirm');
      expect(frame).toContain('networkMode:PUBLIC');
      expect(frame).toContain('advancedSelected:false');
    });

    it('setAdvanced with network selected navigates to networkMode', () => {
      vi.useFakeTimers();
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['network', 'headers', 'auth', 'lifecycle']));
      // Flush setTimeout used for navigating to first sub-step
      act(() => {
        vi.runAllTimers();
      });

      const frame = lastFrame()!;
      expect(frame).toContain('step:networkMode');
      expect(frame).toContain('advancedSelected:true');
      vi.useRealTimers();
    });

    it('setAdvanced with settings injects sub-steps after advanced', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['network', 'headers', 'auth', 'lifecycle']));

      const steps = ref.current!.wizard.steps;
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual([
        'advanced',
        'networkMode',
        'requestHeaderAllowlist',
        'authorizerType',
        'idleTimeout',
        'maxLifetime',
        'confirm',
      ]);
    });

    it('network setting with VPC injects subnets and securityGroups', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['network', 'headers', 'auth', 'lifecycle']));
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
        'idleTimeout',
        'maxLifetime',
        'confirm',
      ]);
    });
  });

  describe('state cleanup on toggle', () => {
    function walkToAdvancedAndSelectSettings(ref: React.RefObject<HarnessHandle | null>) {
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
      });
      act(() => ref.current!.wizard.setAdvanced(['network', 'headers', 'auth', 'lifecycle']));
      act(() => ref.current!.wizard.setNetworkMode('VPC'));
      act(() => ref.current!.wizard.setSubnets(['subnet-123']));
      act(() => ref.current!.wizard.setSecurityGroups(['sg-456']));
    }

    it('switching to empty selection clears VPC config', () => {
      const { ref } = setup();
      walkToAdvancedAndSelectSettings(ref);

      // Now go back and deselect all
      act(() => ref.current!.wizard.setAdvanced([]));

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
      walkToAdvancedAndSelectSettings(ref);

      act(() => ref.current!.wizard.setAdvanced([]));

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

  describe('dockerfile advanced setting', () => {
    function walkToAdvancedWithContainer(ref: React.RefObject<HarnessHandle | null>) {
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('Container');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
      });
    }

    it('setAdvanced with only dockerfile navigates to dockerfile step', () => {
      vi.useFakeTimers();
      const { ref, lastFrame } = setup();
      walkToAdvancedWithContainer(ref);
      expect(lastFrame()).toContain('step:advanced');

      act(() => ref.current!.wizard.setAdvanced(['dockerfile']));
      act(() => {
        vi.runAllTimers();
      });

      expect(lastFrame()).toContain('step:dockerfile');
      vi.useRealTimers();
    });

    it('setDockerfile navigates to confirm when only dockerfile is selected', () => {
      vi.useFakeTimers();
      const { ref, lastFrame } = setup();
      walkToAdvancedWithContainer(ref);

      act(() => ref.current!.wizard.setAdvanced(['dockerfile']));
      act(() => {
        vi.runAllTimers();
      });
      expect(lastFrame()).toContain('step:dockerfile');

      act(() => ref.current!.wizard.setDockerfile('Dockerfile.gpu'));
      act(() => {
        vi.runAllTimers();
      });

      expect(lastFrame()).toContain('step:confirm');
      expect(lastFrame()).toContain('dockerfile:Dockerfile.gpu');
      vi.useRealTimers();
    });

    it('dockerfile + lifecycle injects both sub-steps but not networkMode', () => {
      const { ref } = setup();
      walkToAdvancedWithContainer(ref);

      act(() => ref.current!.wizard.setAdvanced(['dockerfile', 'lifecycle']));

      const steps = ref.current!.wizard.steps;
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'idleTimeout', 'maxLifetime', 'confirm']);
      expect(steps).not.toContain('networkMode');
    });

    it('dockerfile is hidden for CodeZip builds even when selected', () => {
      const { ref } = setup();
      // Use CodeZip (default from walkToAdvanced)
      act(() => {
        ref.current!.wizard.setProjectName('Test');
        ref.current!.wizard.setLanguage('Python');
        ref.current!.wizard.setBuildType('CodeZip');
        ref.current!.wizard.setProtocol('HTTP');
        ref.current!.wizard.setSdk('Strands');
        ref.current!.wizard.setModelProvider('Bedrock');
        ref.current!.wizard.setMemory('none');
      });

      // Even if dockerfile somehow gets into the set, it shouldn't appear for CodeZip
      act(() => ref.current!.wizard.setAdvanced(['dockerfile', 'lifecycle']));

      const steps = ref.current!.wizard.steps;
      expect(steps).not.toContain('dockerfile');
      expect(steps).toContain('idleTimeout');
    });

    it('deselecting all advanced clears dockerfile config', () => {
      vi.useFakeTimers();
      const { ref } = setup();
      walkToAdvancedWithContainer(ref);

      act(() => ref.current!.wizard.setAdvanced(['dockerfile']));
      act(() => {
        vi.runAllTimers();
      });
      act(() => ref.current!.wizard.setDockerfile('Dockerfile.gpu'));
      act(() => {
        vi.runAllTimers();
      });
      expect(ref.current!.wizard.config.dockerfile).toBe('Dockerfile.gpu');

      // Go back and deselect all
      act(() => ref.current!.wizard.setAdvanced([]));

      expect(ref.current!.wizard.config.dockerfile).toBeUndefined();
      expect(ref.current!.wizard.step).toBe('confirm');
      vi.useRealTimers();
    });
  });

  describe('filesystem advanced setting', () => {
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

    it('filesystem step is included in steps when filesystem is selected', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['filesystem']));

      expect(ref.current!.wizard.steps).toContain('sessionStorageMountPath');
    });

    it('setAdvanced with only filesystem navigates to sessionStorageMountPath step', () => {
      vi.useFakeTimers();
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['filesystem']));
      act(() => {
        vi.runAllTimers();
      });

      expect(lastFrame()).toContain('step:sessionStorageMountPath');
      vi.useRealTimers();
    });

    it('setSessionStorageMountPath rejects invalid path and sets error without advancing', () => {
      vi.useFakeTimers();
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['filesystem']));
      act(() => {
        vi.runAllTimers();
      });

      let result: boolean | undefined;
      act(() => {
        result = ref.current!.wizard.setSessionStorageMountPath('/bad/path/too/deep');
      });
      act(() => {
        vi.runAllTimers();
      });

      expect(result).toBe(false);
      expect(ref.current!.wizard.error).toBeTruthy();
      expect(ref.current!.wizard.step).toBe('sessionStorageMountPath');
      vi.useRealTimers();
    });

    it('setSessionStorageMountPath accepts valid path, clears error, and advances to confirm', () => {
      vi.useFakeTimers();
      const { ref, lastFrame } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['filesystem']));
      act(() => {
        vi.runAllTimers();
      });

      let result: boolean | undefined;
      act(() => {
        result = ref.current!.wizard.setSessionStorageMountPath('/mnt/data');
      });
      act(() => {
        vi.runAllTimers();
      });

      expect(result).toBe(true);
      expect(ref.current!.wizard.error).toBeNull();
      expect(lastFrame()).toContain('step:confirm');
      expect(ref.current!.wizard.config.sessionStorageMountPath).toBe('/mnt/data');
      vi.useRealTimers();
    });

    it('lifecycle + filesystem injects both sub-step groups', () => {
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['lifecycle', 'filesystem']));

      const steps = ref.current!.wizard.steps;
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual([
        'advanced',
        'idleTimeout',
        'maxLifetime',
        'sessionStorageMountPath',
        'confirm',
      ]);
    });

    it('deselecting all advanced clears sessionStorageMountPath config', () => {
      vi.useFakeTimers();
      const { ref } = setup();
      walkToAdvanced(ref);

      act(() => ref.current!.wizard.setAdvanced(['filesystem']));
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        ref.current!.wizard.setSessionStorageMountPath('/mnt/data');
      });
      act(() => {
        vi.runAllTimers();
      });
      expect(ref.current!.wizard.config.sessionStorageMountPath).toBe('/mnt/data');

      act(() => ref.current!.wizard.setAdvanced([]));

      expect(ref.current!.wizard.config.sessionStorageMountPath).toBeUndefined();
      expect(ref.current!.wizard.step).toBe('confirm');
      vi.useRealTimers();
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
        ref.current!.wizard.setAdvanced(['network']);
      });
      expect(lastFrame()).toContain('advancedSelected:true');

      act(() => ref.current!.wizard.reset());

      expect(lastFrame()).toContain('advancedSelected:false');
    });
  });
});

describe('validateDockerfileInput', () => {
  it('accepts empty string (use default)', () => {
    expect(validateDockerfileInput('')).toBe(true);
    expect(validateDockerfileInput('  ')).toBe(true);
  });

  it.each(['Dockerfile', 'Dockerfile.gpu', 'Dockerfile.dev-v2', 'my.Dockerfile'])(
    'accepts valid filename "%s"',
    name => {
      expect(validateDockerfileInput(name)).toBe(true);
    }
  );

  it('accepts path input (delegates existence check to caller)', () => {
    expect(validateDockerfileInput('../shared/Dockerfile.gpu')).toBe(true);
    expect(validateDockerfileInput('/absolute/path/Dockerfile')).toBe(true);
  });

  it('rejects name exceeding 255 characters', () => {
    const longName = 'D' + 'a'.repeat(255);
    expect(validateDockerfileInput(longName)).toContain('255 characters');
  });

  it.each(['.hidden', '-bad', '_under'])('rejects invalid filename "%s"', name => {
    const result = validateDockerfileInput(name);
    expect(result).not.toBe(true);
  });
});
