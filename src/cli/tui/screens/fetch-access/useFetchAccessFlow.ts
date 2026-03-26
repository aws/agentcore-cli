import { isMacOS, isWindows } from '../../../../lib/utils/platform';
import { getErrorMessage } from '../../../errors';
import type { GatewayInfo, TokenFetchResult } from '../../../operations/fetch-access';
import { fetchGatewayToken, listGateways } from '../../../operations/fetch-access';
import { spawn } from 'node:child_process';
import { useCallback, useEffect, useRef, useState } from 'react';

type FetchAccessPhase = 'loading' | 'picking' | 'fetching' | 'result' | 'error';

interface FetchAccessState {
  phase: FetchAccessPhase;
  gateways: GatewayInfo[];
  selectedIndex: number;
  selectedGateway?: string;
  result?: TokenFetchResult;
  error?: string;
  tokenVisible: boolean;
  fetchedAt?: number;
}

export function useFetchAccessFlow() {
  const [state, setState] = useState<FetchAccessState>({
    phase: 'loading',
    gateways: [],
    selectedIndex: 0,
    tokenVisible: false,
  });

  const mountedRef = useRef(true);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Load gateways on mount
  useEffect(() => {
    listGateways()
      .then(gateways => {
        if (!mountedRef.current) return;

        if (gateways.length === 0) {
          setState(prev => ({
            ...prev,
            phase: 'error',
            error: 'No deployed gateways found. Run `agentcore deploy` first.',
          }));
          return;
        }

        // Auto-skip picker when only one gateway
        if (gateways.length === 1) {
          setState(prev => ({
            ...prev,
            gateways,
            selectedGateway: gateways[0]!.name,
            phase: 'fetching',
          }));
          return;
        }

        setState(prev => ({
          ...prev,
          gateways,
          phase: 'picking',
        }));
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setState(prev => ({
          ...prev,
          phase: 'error',
          error: getErrorMessage(error),
        }));
      });
  }, []);

  // Fetch access info when gateway is selected
  useEffect(() => {
    if (state.phase !== 'fetching' || !state.selectedGateway) return;

    fetchGatewayToken(state.selectedGateway)
      .then(result => {
        if (!mountedRef.current) return;
        setState(prev => ({
          ...prev,
          phase: 'result',
          result,
          tokenVisible: false,
          fetchedAt: Date.now(),
        }));
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setState(prev => ({
          ...prev,
          phase: 'error',
          error: getErrorMessage(error),
        }));
      });
  }, [state.phase, state.selectedGateway]);

  const selectGateway = useCallback((name: string) => {
    setState(prev => ({
      ...prev,
      selectedGateway: name,
      phase: 'fetching',
      tokenVisible: false,
    }));
  }, []);

  const moveSelection = useCallback((direction: 1 | -1) => {
    setState(prev => {
      if (prev.phase !== 'picking' || prev.gateways.length === 0) return prev;
      const newIndex = (prev.selectedIndex + direction + prev.gateways.length) % prev.gateways.length;
      return { ...prev, selectedIndex: newIndex };
    });
  }, []);

  const confirmSelection = useCallback(() => {
    setState(prev => {
      if (prev.phase !== 'picking') return prev;
      const gateway = prev.gateways[prev.selectedIndex];
      if (!gateway) return prev;
      return {
        ...prev,
        selectedGateway: gateway.name,
        phase: 'fetching',
        tokenVisible: false,
      };
    });
  }, []);

  const toggleTokenVisibility = useCallback(() => {
    setState(prev => {
      if (prev.phase !== 'result' || !prev.result?.token) return prev;
      return { ...prev, tokenVisible: !prev.tokenVisible };
    });
  }, []);

  const [copied, setCopied] = useState(false);

  const copyToken = useCallback(() => {
    const token = state.result?.token;
    if (!token) return;

    const cmd = isMacOS ? 'pbcopy' : isWindows ? 'clip' : 'xclip';
    const args = isMacOS || isWindows ? [] : ['-selection', 'clipboard'];
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    child.on('error', () => {});
    child.stdin.write(token);
    child.stdin.end();

    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopied(false);
    }, 2000);
  }, [state.result?.token]);

  const [tokenMayBeExpired, setTokenMayBeExpired] = useState(false);
  useEffect(() => {
    const expiresIn = state.result?.expiresIn;
    const fetchedAt = state.fetchedAt;
    if (expiresIn === undefined || fetchedAt === undefined) return;
    const remaining = fetchedAt + expiresIn * 1000 - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => {
        if (mountedRef.current) setTokenMayBeExpired(true);
      },
      Math.min(remaining, 0x7fffffff)
    );
    return () => clearTimeout(timer);
  }, [state.result?.expiresIn, state.fetchedAt]);

  const refresh = useCallback(() => {
    setTokenMayBeExpired(false);
    setState(prev => {
      if (!prev.selectedGateway) return prev;
      return {
        ...prev,
        phase: 'fetching',
        result: undefined,
        error: undefined,
        tokenVisible: false,
      };
    });
  }, []);

  const goBackToPicker = useCallback(() => {
    setTokenMayBeExpired(false);
    setState(prev => {
      if (prev.gateways.length <= 1) return prev;
      return {
        ...prev,
        phase: 'picking',
        result: undefined,
        error: undefined,
        selectedGateway: undefined,
        tokenVisible: false,
      };
    });
  }, []);

  // Can go back to picker if there are multiple gateways (single-gateway auto-skips picker)
  const canGoBack = state.gateways.length > 1;

  return {
    phase: state.phase,
    gateways: state.gateways,
    selectedIndex: state.selectedIndex,
    selectedGateway: state.selectedGateway,
    result: state.result,
    error: state.error,
    tokenVisible: state.tokenVisible,
    tokenMayBeExpired,
    copied,
    canGoBack,
    selectGateway,
    moveSelection,
    confirmSelection,
    toggleTokenVisibility,
    copyToken,
    refresh,
    goBackToPicker,
  };
}
