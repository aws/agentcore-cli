import { isMacOS, isWindows } from '../../../../lib/utils/platform';
import { getErrorMessage } from '../../../errors';
import type { ResourceInfo, TokenFetchResult } from '../../../operations/fetch-access';
import { fetchGatewayToken, fetchRuntimeToken, listAgents, listGateways } from '../../../operations/fetch-access';
import { spawn } from 'node:child_process';
import { useCallback, useEffect, useRef, useState } from 'react';

async function fetchAgentAccess(resource: ResourceInfo): Promise<TokenFetchResult> {
  if (resource.authType === 'AWS_IAM') {
    return {
      url: '',
      authType: 'AWS_IAM',
      message: 'This agent uses AWS_IAM authentication. Use AWS SigV4 signing to invoke.',
    };
  }

  // For CUSTOM_JWT agents, attempt token fetch directly.
  // Errors (missing credential, bad config) surface in the error phase.
  const tokenResult = await fetchRuntimeToken(resource.name);
  return {
    url: '',
    authType: 'CUSTOM_JWT',
    token: tokenResult.token,
    expiresIn: tokenResult.expiresIn,
  };
}

type FetchAccessPhase = 'loading' | 'picking' | 'fetching' | 'result' | 'error';

interface FetchAccessState {
  phase: FetchAccessPhase;
  resources: ResourceInfo[];
  selectedIndex: number;
  selectedResource?: ResourceInfo;
  result?: TokenFetchResult;
  error?: string;
  tokenVisible: boolean;
  fetchedAt?: number;
}

export function useFetchAccessFlow() {
  const [state, setState] = useState<FetchAccessState>({
    phase: 'loading',
    resources: [],
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

  // Load gateways and agents on mount
  useEffect(() => {
    Promise.all([listGateways(), listAgents()])
      .then(([gateways, agents]) => {
        if (!mountedRef.current) return;

        const resources: ResourceInfo[] = [
          ...gateways.map(gw => ({ name: gw.name, resourceType: 'gateway' as const, authType: gw.authType })),
          ...agents.map(ag => ({ name: ag.name, resourceType: 'agent' as const, authType: ag.authType })),
        ];

        if (resources.length === 0) {
          setState(prev => ({
            ...prev,
            phase: 'error',
            error: 'No deployed gateways or agents found. Run `agentcore deploy` first.',
          }));
          return;
        }

        // Auto-skip picker when only one resource
        if (resources.length === 1) {
          setState(prev => ({
            ...prev,
            resources,
            selectedResource: resources[0],
            phase: 'fetching',
          }));
          return;
        }

        setState(prev => ({
          ...prev,
          resources,
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

  // Fetch access info when resource is selected
  useEffect(() => {
    if (state.phase !== 'fetching' || !state.selectedResource) return;

    const resource = state.selectedResource;

    const fetchToken: Promise<TokenFetchResult> =
      resource.resourceType === 'gateway' ? fetchGatewayToken(resource.name) : fetchAgentAccess(resource);

    fetchToken
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
  }, [state.phase, state.selectedResource]);

  const selectResource = useCallback((resource: ResourceInfo) => {
    setState(prev => ({
      ...prev,
      selectedResource: resource,
      phase: 'fetching',
      tokenVisible: false,
    }));
  }, []);

  const moveSelection = useCallback((direction: 1 | -1) => {
    setState(prev => {
      if (prev.phase !== 'picking' || prev.resources.length === 0) return prev;
      const newIndex = (prev.selectedIndex + direction + prev.resources.length) % prev.resources.length;
      return { ...prev, selectedIndex: newIndex };
    });
  }, []);

  const confirmSelection = useCallback(() => {
    setState(prev => {
      if (prev.phase !== 'picking') return prev;
      const resource = prev.resources[prev.selectedIndex];
      if (!resource) return prev;
      return {
        ...prev,
        selectedResource: resource,
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
      if (!prev.selectedResource) return prev;
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
      if (prev.resources.length <= 1) return prev;
      return {
        ...prev,
        phase: 'picking',
        result: undefined,
        error: undefined,
        selectedResource: undefined,
        tokenVisible: false,
      };
    });
  }, []);

  // Can go back to picker if there are multiple resources (single-resource auto-skips picker)
  const canGoBack = state.resources.length > 1;

  return {
    phase: state.phase,
    resources: state.resources,
    selectedIndex: state.selectedIndex,
    selectedResource: state.selectedResource,
    result: state.result,
    error: state.error,
    tokenVisible: state.tokenVisible,
    tokenMayBeExpired,
    copied,
    canGoBack,
    selectResource,
    moveSelection,
    confirmSelection,
    toggleTokenVisibility,
    copyToken,
    refresh,
    goBackToPicker,
  };
}
