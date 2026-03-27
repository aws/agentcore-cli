import { ConfigIO } from '../../../../lib';
import type {
  AgentCoreDeployedState,
  AwsDeploymentTarget,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  RuntimeAuthorizerType,
  AgentCoreProjectSpec as _AgentCoreProjectSpec,
} from '../../../../schema';
import {
  DEFAULT_RUNTIME_USER_ID,
  type McpToolDef,
  invokeA2ARuntime,
  invokeAgentRuntimeStreaming,
  mcpCallTool,
  mcpListTools,
} from '../../../aws';
import { getErrorMessage } from '../../../errors';
import { InvokeLogger } from '../../../logging';
import { formatMcpToolList } from '../../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../../operations/fetch-access';
import { generateSessionId } from '../../../operations/session';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface InvokeConfig {
  agents: {
    name: string;
    state: AgentCoreDeployedState;
    modelProvider?: ModelProvider;
    networkMode?: NetworkMode;
    protocol?: ProtocolMode;
    authorizerType?: RuntimeAuthorizerType;
  }[];
  target: AwsDeploymentTarget;
  targetName: string;
  projectName: string;
}

export interface InvokeFlowOptions {
  initialSessionId?: string;
  initialUserId?: string;
  /** Custom headers to forward to the agent runtime on every invocation */
  headers?: Record<string, string>;
  initialBearerToken?: string;
}

export type TokenFetchState = 'idle' | 'fetching' | 'fetched' | 'error';

export interface InvokeFlowState {
  phase: 'loading' | 'ready' | 'invoking' | 'error';
  config: InvokeConfig | null;
  selectedAgent: number;
  messages: { role: 'user' | 'assistant'; content: string; isHint?: boolean }[];
  error: string | null;
  logFilePath: string | null;
  sessionId: string | null;
  userId: string;
  bearerToken: string;
  tokenFetchState: TokenFetchState;
  tokenFetchError: string | null;
  tokenExpiresIn: number | undefined;
  mcpTools: McpToolDef[];
  mcpToolsFetched: boolean;
  selectAgent: (index: number) => void;
  setUserId: (id: string) => void;
  setBearerToken: (token: string) => void;
  fetchBearerToken: () => Promise<void>;
  invoke: (prompt: string) => Promise<void>;
  newSession: () => void;
  fetchMcpTools: () => Promise<void>;
}

export function useInvokeFlow(options: InvokeFlowOptions = {}): InvokeFlowState {
  const { initialSessionId, initialUserId, headers, initialBearerToken } = options;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invoking' | 'error'>('loading');
  const [config, setConfig] = useState<InvokeConfig | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string; isHint?: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string>(initialUserId ?? DEFAULT_RUNTIME_USER_ID);
  const [bearerToken, setBearerToken] = useState<string>(initialBearerToken ?? '');
  const [tokenFetchState, setTokenFetchState] = useState<TokenFetchState>('idle');
  const [tokenFetchError, setTokenFetchError] = useState<string | null>(null);
  const [tokenExpiresIn, setTokenExpiresIn] = useState<number | undefined>(undefined);

  // MCP state
  const [mcpTools, setMcpTools] = useState<McpToolDef[]>([]);
  const [mcpToolsFetched, setMcpToolsFetched] = useState(false);
  const mcpToolsRef = useRef<McpToolDef[]>([]);
  const mcpSessionIdRef = useRef<string | undefined>(undefined);

  // Persistent logger for the session
  const loggerRef = useRef<InvokeLogger | null>(null);

  // Load config on mount
  useEffect(() => {
    const load = async () => {
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        const deployedState = await configIO.readDeployedState();
        const awsTargets = await configIO.readAWSDeploymentTargets();

        const targetNames = Object.keys(deployedState.targets);
        if (targetNames.length === 0) {
          setError('No deployed targets found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        const targetName = targetNames[0]!;
        const targetState = deployedState.targets[targetName];
        const targetConfig = awsTargets.find(t => t.name === targetName);

        if (!targetConfig) {
          setError(`Target config '${targetName}' not found`);
          setPhase('error');
          return;
        }

        const agents: InvokeConfig['agents'] = [];
        for (const agent of project.agents) {
          const state = targetState?.resources?.agents?.[agent.name];
          if (!state) continue;
          agents.push({
            name: agent.name,
            state,
            modelProvider: undefined,
            networkMode: agent.networkMode,
            protocol: agent.protocol,
            authorizerType: agent.authorizerType,
          });
        }

        if (agents.length === 0) {
          setError('No deployed agents found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        setConfig({ agents, target: targetConfig, targetName, projectName: project.name });

        // Initialize session ID - always generate fresh unless explicitly provided
        if (initialSessionId) {
          setSessionId(initialSessionId);
        } else {
          const newId = generateSessionId();
          setSessionId(newId);
        }

        setPhase('ready');
      } catch (err) {
        setError(getErrorMessage(err));
        setPhase('error');
      }
    };
    void load();
  }, [initialSessionId]);

  const getMcpInvokeOptions = useCallback(() => {
    if (!config) return null;
    const agent = config.agents[selectedAgent];
    if (!agent) return null;
    return {
      region: config.target.region,
      runtimeArn: agent.state.runtimeArn,
      userId,
      mcpSessionId: mcpSessionIdRef.current,
      headers,
    };
  }, [config, selectedAgent, userId, headers]);

  const fetchMcpTools = useCallback(async () => {
    const opts = getMcpInvokeOptions();
    if (!opts) return;

    try {
      const result = await mcpListTools(opts);
      setMcpTools(result.tools);
      mcpToolsRef.current = result.tools;
      mcpSessionIdRef.current = result.mcpSessionId;
      setMcpToolsFetched(true);
      if (result.tools.length > 0) {
        setMessages(prev => [...prev, { role: 'assistant', content: formatMcpToolList(result.tools), isHint: true }]);
      }
    } catch (err) {
      const errMsg = getErrorMessage(err);
      setMessages(prev => [...prev, { role: 'assistant', content: `Failed to list tools: ${errMsg}` }]);
      setMcpTools([]);
      mcpToolsRef.current = [];
      setMcpToolsFetched(true);
    }
  }, [getMcpInvokeOptions]);

  const fetchBearerToken = useCallback(async () => {
    if (!config) return;
    const agent = config.agents[selectedAgent];
    if (agent?.authorizerType !== 'CUSTOM_JWT') return;

    // Check if credentials are set up before attempting fetch
    const canFetch = await canFetchRuntimeToken(agent.name);
    if (!canFetch) {
      // No credential configured — silently skip, user can press T to enter manually
      return;
    }

    setTokenFetchState('fetching');
    setTokenFetchError(null);
    try {
      const result = await fetchRuntimeToken(agent.name, { deployTarget: config.targetName });
      setBearerToken(result.token);
      setTokenExpiresIn(result.expiresIn);
      setTokenFetchState('fetched');
    } catch (err) {
      setTokenFetchError(getErrorMessage(err));
      setTokenFetchState('error');
    }
  }, [config, selectedAgent]);

  // Track current streaming content to avoid stale closure issues
  const streamingContentRef = useRef('');

  const invoke = useCallback(
    async (prompt: string) => {
      if (!config || phase === 'invoking') return;

      const agent = config.agents[selectedAgent];
      if (!agent) return;

      const isMcp = agent.protocol === 'MCP';

      // Create logger on first invoke or if agent changed
      if (!loggerRef.current) {
        loggerRef.current = new InvokeLogger({
          agentName: agent.name,
          runtimeArn: agent.state.runtimeArn,
          region: config.target.region,
          sessionId: sessionId ?? undefined,
        });
        setLogFilePath(loggerRef.current.getAbsoluteLogPath());
      }

      const logger = loggerRef.current;

      // MCP: handle tool calls
      if (isMcp) {
        // "list" refreshes the tool list
        if (prompt.trim().toLowerCase() === 'list') {
          setMessages(prev => [...prev, { role: 'user', content: prompt }]);
          setPhase('invoking');
          await fetchMcpTools();
          setPhase('ready');
          return;
        }

        // Parse "tool_name {json_args}" or just "tool_name"
        const match = /^(\S+)\s*(.*)/.exec(prompt);
        if (!match) return;
        const toolName = match[1]!;
        const argsStr = match[2]?.trim() ?? '';

        setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
        setPhase('invoking');

        logger.logPrompt(`MCP tools/call: ${toolName}(${argsStr})`, sessionId ?? undefined, userId);

        try {
          let args: Record<string, unknown> = {};
          if (argsStr) {
            args = JSON.parse(argsStr) as Record<string, unknown>;
          }
          const opts = getMcpInvokeOptions();
          if (!opts) throw new Error('No agent config available');

          const result = await mcpCallTool(opts, toolName, args);

          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: `Result: ${result}` };
            }
            return updated;
          });

          logger.logResponse(result);
        } catch (err) {
          const errMsg = getErrorMessage(err);
          logger.logError(err, 'MCP call failed');

          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: `Error: ${errMsg}` };
            }
            return updated;
          });
        }

        setPhase('ready');
        return;
      }

      // HTTP / A2A: streaming invoke
      const isA2A = agent.protocol === 'A2A';
      setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
      setPhase('invoking');
      streamingContentRef.current = '';

      logger.logPrompt(prompt, sessionId ?? undefined, userId);

      try {
        const result = isA2A
          ? await invokeA2ARuntime(
              { region: config.target.region, runtimeArn: agent.state.runtimeArn, userId, logger, headers },
              prompt
            )
          : await invokeAgentRuntimeStreaming({
              region: config.target.region,
              runtimeArn: agent.state.runtimeArn,
              payload: prompt,
              sessionId: sessionId ?? undefined,
              userId,
              logger,
              headers,
              bearerToken: bearerToken || undefined,
            });

        if (result.sessionId) {
          setSessionId(result.sessionId);
          logger.updateSessionId(result.sessionId);
        }

        for await (const chunk of result.stream) {
          streamingContentRef.current += chunk;
          const currentContent = streamingContentRef.current;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: currentContent };
            }
            return updated;
          });
        }

        logger.logResponse(streamingContentRef.current);

        setPhase('ready');
      } catch (err) {
        const errMsg = getErrorMessage(err);
        logger.logError(err, 'invoke streaming failed');

        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { role: 'assistant', content: `Error: ${errMsg}` };
          }
          return updated;
        });
        setPhase('ready');
      }
    },
    [config, selectedAgent, phase, sessionId, userId, headers, bearerToken, fetchMcpTools, getMcpInvokeOptions]
  );

  const newSession = useCallback(() => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
    // Reset MCP session
    mcpSessionIdRef.current = undefined;
    setMcpTools([]);
    mcpToolsRef.current = [];
    setMcpToolsFetched(false);
  }, []);

  return {
    phase,
    config,
    selectedAgent,
    messages,
    error,
    logFilePath,
    sessionId,
    userId,
    bearerToken,
    tokenFetchState,
    tokenFetchError,
    tokenExpiresIn,
    mcpTools,
    mcpToolsFetched,
    selectAgent: setSelectedAgent,
    setUserId,
    setBearerToken,
    fetchBearerToken,
    invoke,
    newSession,
    fetchMcpTools,
  };
}
