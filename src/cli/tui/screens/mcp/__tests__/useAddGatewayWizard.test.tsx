import type { GatewayExceptionLevel } from '../../../../../schema';
import { useAddGatewayWizard } from '../useAddGatewayWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Simple harness -- renders hook state as text for snapshot assertions
// ---------------------------------------------------------------------------

function Harness() {
  const wizard = useAddGatewayWizard();
  return (
    <Text>
      exceptionLevel:{wizard.config.exceptionLevel}
      enableSemanticSearch:{String(wizard.config.enableSemanticSearch)}
      step:{wizard.step}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Imperative harness -- exposes wizard methods via ref for act()-based tests
// ---------------------------------------------------------------------------

interface HarnessHandle {
  setAdvancedConfig: (opts: { enableSemanticSearch: boolean; exceptionLevel: GatewayExceptionLevel }) => void;
  setName: (name: string) => void;
  setAuthorizerType: (type: 'NONE' | 'AWS_IAM' | 'CUSTOM_JWT') => void;
  setJwtConfig: (config: {
    discoveryUrl: string;
    allowedAudience: string[];
    allowedClients: string[];
    allowedScopes?: string[];
    customClaims?: {
      inboundTokenClaimName: string;
      inboundTokenClaimValueType: 'STRING' | 'STRING_ARRAY';
      authorizingClaimMatchValue: {
        claimMatchOperator: 'EQUALS' | 'CONTAINS' | 'CONTAINS_ANY';
        claimMatchValue: {
          matchValueString?: string;
          matchValueStringList?: string[];
        };
      };
    }[];
    clientId?: string;
    clientSecret?: string;
  }) => void;
  goBack: () => void;
}

interface ImperativeHarnessProps {
  unassignedTargetsCount?: number;
}

const ImperativeHarness = React.forwardRef<HarnessHandle, ImperativeHarnessProps>(
  ({ unassignedTargetsCount = 0 }, ref) => {
    const wizard = useAddGatewayWizard(unassignedTargetsCount);
    useImperativeHandle(ref, () => ({
      setAdvancedConfig: wizard.setAdvancedConfig,
      setName: wizard.setName,
      setAuthorizerType: wizard.setAuthorizerType,
      setJwtConfig: wizard.setJwtConfig,
      goBack: wizard.goBack,
    }));
    return (
      <Text>
        exceptionLevel:{wizard.config.exceptionLevel}
        enableSemanticSearch:{String(wizard.config.enableSemanticSearch)}
        step:{wizard.step}
        authorizerType:{wizard.config.authorizerType}
        jwtConfig:{JSON.stringify(wizard.config.jwtConfig ?? null)}
        steps:{wizard.steps.join(',')}
      </Text>
    );
  }
);
ImperativeHarness.displayName = 'ImperativeHarness';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddGatewayWizard', () => {
  describe('defaults', () => {
    it('default config has exceptionLevel NONE', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('exceptionLevel:NONE');
    });

    it('default config has semantic search enabled', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('enableSemanticSearch:true');
    });

    it('default step is name', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('step:name');
    });
  });

  describe('setAdvancedConfig', () => {
    it('setAdvancedConfig sets exception level to DEBUG', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: true,
          exceptionLevel: 'DEBUG',
        });
      });

      expect(lastFrame()).toContain('exceptionLevel:DEBUG');
    });

    it('setAdvancedConfig with all disabled', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: false,
          exceptionLevel: 'NONE',
        });
      });

      expect(lastFrame()).toContain('enableSemanticSearch:false');
      expect(lastFrame()).toContain('exceptionLevel:NONE');
    });

    it('setAdvancedConfig advances to confirm step', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      // Initially on the name step
      expect(lastFrame()).toContain('step:name');

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: true,
          exceptionLevel: 'NONE',
        });
      });

      expect(lastFrame()).toContain('step:confirm');
    });
  });

  describe('JWT config flow', () => {
    it("setAuthorizerType('CUSTOM_JWT') sets step to jwt-config", () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });

      expect(lastFrame()).toContain('step:jwt-config');
    });

    it("setAuthorizerType('CUSTOM_JWT') preserves existing jwtConfig", () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
        });
      });
      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });

      // jwtConfig should still be set (not null) after switching back to CUSTOM_JWT
      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).not.toContain('jwtConfig:null');
      expect(frame).toContain('"discoveryUrl"');
    });

    it("setAuthorizerType('NONE') clears jwtConfig", () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
        });
      });
      act(() => {
        ref.current!.setAuthorizerType('NONE');
      });

      expect(lastFrame()).toContain('jwtConfig:null');
    });

    it('setJwtConfig with full config advances to advanced-config when no unassigned targets', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
          allowedScopes: ['openid'],
          clientId: 'my-client',
          clientSecret: 'my-secret',
        });
      });

      expect(lastFrame()).toContain('step:advanced-config');
    });

    it('setJwtConfig builds correct config object with only selected constraints', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
        });
      });

      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).toContain('"discoveryUrl"');
      expect(frame).toContain('"allowedAudience"');
      expect(frame).toContain('"allowedClients"');
      // optional fields not provided should be absent
      expect(frame).not.toContain('"allowedScopes"');
      expect(frame).not.toContain('"clientId"');
    });

    it('setJwtConfig preserves customClaims in config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: [],
          allowedClients: [],
          customClaims: [
            {
              inboundTokenClaimName: 'department',
              inboundTokenClaimValueType: 'STRING',
              authorizingClaimMatchValue: {
                claimMatchOperator: 'EQUALS',
                claimMatchValue: { matchValueString: 'engineering' },
              },
            },
          ],
        });
      });

      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).toContain('"customClaims"');
      expect(frame).toContain('"department"');
      expect(frame).toContain('"EQUALS"');
    });
  });

  describe('step navigation with JWT', () => {
    it("steps include 'jwt-config' when authorizerType is CUSTOM_JWT", () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });

      expect(lastFrame()).toContain('jwt-config');
    });

    it("steps don't include 'jwt-config' when authorizerType is NONE", () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('NONE');
      });

      // steps list should not contain jwt-config
      const frame = lastFrame()!.replace(/\n/g, '');
      expect(frame).toContain('name,authorizer,advanced-config,confirm');
      expect(frame).not.toContain('jwt-config');
    });

    it('goBack from jwt-config returns to authorizer', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      expect(lastFrame()).toContain('step:jwt-config');

      act(() => {
        ref.current!.goBack();
      });

      expect(lastFrame()).toContain('step:authorizer');
    });
  });

  describe('JWT config with targets', () => {
    it('when unassigned targets exist, setJwtConfig advances to include-targets instead of advanced-config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} unassignedTargetsCount={2} />);

      act(() => {
        ref.current!.setAuthorizerType('CUSTOM_JWT');
      });
      act(() => {
        ref.current!.setJwtConfig({
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
        });
      });

      expect(lastFrame()).toContain('step:include-targets');
    });
  });
});
