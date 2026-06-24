import {
  fetchGatewayToken,
  fetchHarnessToken,
  listAgents,
  listGateways,
  listHarnesses,
} from '../../../../operations/fetch-access';
import { useFetchAccessFlow } from '../useFetchAccessFlow';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../operations/fetch-access', () => ({
  listGateways: vi.fn(),
  listAgents: vi.fn(),
  listHarnesses: vi.fn(),
  fetchGatewayToken: vi.fn(),
  fetchRuntimeToken: vi.fn(),
  fetchHarnessToken: vi.fn(),
}));

const mockListGateways = vi.mocked(listGateways);
const mockListAgents = vi.mocked(listAgents);
const mockListHarnesses = vi.mocked(listHarnesses);
const mockFetchGatewayToken = vi.mocked(fetchGatewayToken);
const mockFetchHarnessToken = vi.mocked(fetchHarnessToken);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockGateways = [
  { name: 'gw-jwt', authType: 'CUSTOM_JWT' as const },
  { name: 'gw-iam', authType: 'AWS_IAM' as const },
];

const mockJwtResult = {
  url: 'https://gw.example.com',
  authType: 'CUSTOM_JWT' as const,
  token: 'test-token-123',
  expiresIn: 3600,
};

const mockNoneResult = {
  url: 'https://gw.example.com',
  authType: 'NONE' as const,
  message: 'No authentication required. Send requests directly to the URL.',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms = 100) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

function PhaseHarness() {
  const flow = useFetchAccessFlow();
  return (
    <Text>
      phase:{flow.phase}
      resourceCount:{flow.resources.length}
      selectedIndex:{flow.selectedIndex}
      tokenVisible:{String(flow.tokenVisible)}
      error:{flow.error ?? ''}
    </Text>
  );
}

interface HarnessHandle {
  moveSelection: (direction: 1 | -1) => void;
  confirmSelection: () => void;
  toggleTokenVisibility: () => void;
  refresh: () => void;
  getPhase: () => string;
  getResult: () => { url: string; authType: string; token?: string; expiresIn?: number; message?: string } | undefined;
  getError: () => string | undefined;
  getTokenVisible: () => boolean;
}

const ImperativeHarness = React.forwardRef<HarnessHandle>((_, ref) => {
  const flow = useFetchAccessFlow();
  useImperativeHandle(ref, () => ({
    moveSelection: flow.moveSelection,
    confirmSelection: flow.confirmSelection,
    toggleTokenVisibility: flow.toggleTokenVisibility,
    refresh: flow.refresh,
    getPhase: () => flow.phase,
    getResult: () => flow.result,
    getError: () => flow.error,
    getTokenVisible: () => flow.tokenVisible,
  }));
  return (
    <Text>
      phase:{flow.phase}
      tokenVisible:{String(flow.tokenVisible)}
      error:{flow.error ?? ''}
      result:{flow.result ? flow.result.authType : 'none'}
    </Text>
  );
});
ImperativeHarness.displayName = 'ImperativeHarness';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => vi.clearAllMocks());

// Default the harness lister to empty so existing gateway/agent cases are unaffected;
// the harness-specific tests override it.
beforeEach(() => mockListHarnesses.mockResolvedValue([]));

describe('useFetchAccessFlow', () => {
  describe('initial loading state', () => {
    it('starts in loading phase on mount', () => {
      mockListGateways.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      mockListAgents.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      const { lastFrame } = render(<PhaseHarness />);

      expect(lastFrame()).toContain('phase:loading');
    });
  });

  describe('transitions to picking for multiple resources', () => {
    it('enters picking phase when combined gateways and agents total 2+', async () => {
      mockListGateways.mockResolvedValue(mockGateways);
      mockListAgents.mockResolvedValue([]);
      const { lastFrame } = render(<PhaseHarness />);

      await delay();

      expect(lastFrame()).toContain('phase:picking');
      expect(lastFrame()).toContain('resourceCount:2');
    });
  });

  describe('auto-skip picker for single resource', () => {
    it('skips picking and enters fetching phase when only 1 resource is returned', async () => {
      mockFetchGatewayToken.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      mockListGateways.mockResolvedValue([{ name: 'gw-only', authType: 'NONE' as const }]);
      mockListAgents.mockResolvedValue([]);
      const { lastFrame } = render(<PhaseHarness />);

      await delay();

      expect(lastFrame()).toContain('phase:fetching');
    });
  });

  describe('error when no resources found', () => {
    it('transitions to error phase when both lists return empty', async () => {
      mockListGateways.mockResolvedValue([]);
      mockListAgents.mockResolvedValue([]);
      const { lastFrame } = render(<PhaseHarness />);

      await delay();

      expect(lastFrame()).toContain('phase:error');
    });
  });

  describe('confirmSelection transitions to fetching', () => {
    it('calling confirmSelection in picking phase sets phase to fetching', async () => {
      mockListGateways.mockResolvedValue(mockGateways);
      mockListAgents.mockResolvedValue([]);
      mockFetchGatewayToken.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();
      expect(lastFrame()).toContain('phase:picking');

      act(() => {
        ref.current!.confirmSelection();
      });

      expect(lastFrame()).toContain('phase:fetching');
    });
  });

  describe('token visibility toggle', () => {
    it('toggleTokenVisibility flips tokenVisible for CUSTOM_JWT result with token', async () => {
      mockListGateways.mockResolvedValue([{ name: 'gw-jwt', authType: 'CUSTOM_JWT' as const }]);
      mockListAgents.mockResolvedValue([]);
      mockFetchGatewayToken.mockResolvedValue(mockJwtResult);
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();
      expect(lastFrame()).toContain('phase:result');
      expect(lastFrame()).toContain('tokenVisible:false');

      act(() => {
        ref.current!.toggleTokenVisibility();
      });

      expect(lastFrame()).toContain('tokenVisible:true');

      act(() => {
        ref.current!.toggleTokenVisibility();
      });

      expect(lastFrame()).toContain('tokenVisible:false');
    });

    it('toggleTokenVisibility is a no-op when result has no token (NONE auth type)', async () => {
      mockListGateways.mockResolvedValue([{ name: 'gw-none', authType: 'NONE' as const }]);
      mockListAgents.mockResolvedValue([]);
      mockFetchGatewayToken.mockResolvedValue(mockNoneResult);
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();
      expect(lastFrame()).toContain('phase:result');
      expect(lastFrame()).toContain('tokenVisible:false');

      act(() => {
        ref.current!.toggleTokenVisibility();
      });

      expect(lastFrame()).toContain('tokenVisible:false');
    });
  });

  describe('refresh re-fetches access info', () => {
    it('calling refresh in result phase transitions back to fetching', async () => {
      mockListGateways.mockResolvedValue([{ name: 'gw-jwt', authType: 'CUSTOM_JWT' as const }]);
      mockListAgents.mockResolvedValue([]);
      mockFetchGatewayToken.mockResolvedValueOnce(mockJwtResult).mockReturnValue(
        new Promise(() => {
          /* never resolves on second call */
        })
      );
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();
      expect(lastFrame()).toContain('phase:result');

      act(() => {
        ref.current!.refresh();
      });

      expect(lastFrame()).toContain('phase:fetching');
    });
  });

  describe('error handling for failed fetch', () => {
    it('transitions to error phase with error message when fetchGatewayToken throws', async () => {
      mockListGateways.mockResolvedValue([{ name: 'gw-jwt', authType: 'CUSTOM_JWT' as const }]);
      mockListAgents.mockResolvedValue([]);
      mockFetchGatewayToken.mockRejectedValue(new Error('Token request failed: 401 Unauthorized'));
      const { lastFrame } = render(<PhaseHarness />);

      await delay();

      expect(lastFrame()).toContain('phase:error');
    });
  });

  describe('harness resources', () => {
    it('fetches a CUSTOM_JWT token for a single deployed harness', async () => {
      mockListGateways.mockResolvedValue([]);
      mockListAgents.mockResolvedValue([]);
      mockListHarnesses.mockResolvedValue([{ name: 'MyHarness', authType: 'CUSTOM_JWT' }]);
      mockFetchHarnessToken.mockResolvedValue({ token: 'harness-token', expiresIn: 3600 });
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();

      expect(mockFetchHarnessToken).toHaveBeenCalledWith('MyHarness');
      expect(lastFrame()).toContain('phase:result');
      expect(ref.current!.getResult()?.authType).toBe('CUSTOM_JWT');
      expect(ref.current!.getResult()?.token).toBe('harness-token');
    });

    it('shows the AWS_IAM guidance message for an AWS_IAM harness without fetching a token', async () => {
      mockListGateways.mockResolvedValue([]);
      mockListAgents.mockResolvedValue([]);
      mockListHarnesses.mockResolvedValue([{ name: 'IamHarness', authType: 'AWS_IAM' }]);
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      await delay();

      expect(mockFetchHarnessToken).not.toHaveBeenCalled();
      expect(lastFrame()).toContain('phase:result');
      expect(ref.current!.getResult()?.authType).toBe('AWS_IAM');
      expect(ref.current!.getResult()?.message).toContain('harness');
    });

    it('includes harnesses alongside gateways and agents in the picker', async () => {
      mockListGateways.mockResolvedValue([{ name: 'gw-jwt', authType: 'CUSTOM_JWT' as const }]);
      mockListAgents.mockResolvedValue([{ name: 'agent-one', authType: 'AWS_IAM' as const }]);
      mockListHarnesses.mockResolvedValue([{ name: 'MyHarness', authType: 'CUSTOM_JWT' }]);
      const { lastFrame } = render(<PhaseHarness />);

      await delay();

      expect(lastFrame()).toContain('phase:picking');
      expect(lastFrame()).toContain('resourceCount:3');
    });
  });
});
