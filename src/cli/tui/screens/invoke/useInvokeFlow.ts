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
  AguiEventType,
  DEFAULT_RUNTIME_USER_ID,
  type McpToolDef,
  buildAguiRunInput,
  executeBashCommand,
  invokeA2ARuntime,
  invokeAgentRuntimeStreaming,
  invokeAguiRuntime,
  mcpCallTool,
  mcpListTools,
} from '../../../aws';
import { getErrorMessage } from '../../../errors';
import { InvokeLogger } from '../../../logging';
import { formatMcpToolList } from '../../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../../operations/fetch-access';
import { generateSessionId } from '../../../operations/session';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Structured message part for rich AGUI event rendering */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: string; result?: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'error'; message: string; code?: string };

export interface InvokeConfig {
  runtimes: {
    name: string;
    state: AgentCoreDeployedState;
    modelProvider?: ModelProvider;
    networkMode?: NetworkMode;
    protocol?: ProtocolMode;
    authorizerType?: RuntimeAuthorizerType;
    baggage?: string;
    supportsTraces: boolean;
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
  messages: { role: 'user' | 'assistant'; content: string; isHint?: boolean; parts?: MessagePart[] }[];
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
  execCommand: (command: string) => Promise<void>;
  newSession: () => void;
  fetchMcpTools: () => Promise<void>;
}

export function useInvokeFlow(options: InvokeFlowOptions = {}): InvokeFlowState {
  const { initialSessionId, initialUserId, headers, initialBearerToken } = options;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invoking' | 'error'>('loading');
  const [config, setConfig] = useState<InvokeConfig | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [messages, setMessages] = useState<
    { role: 'user' | 'assistant'; content: string; isHint?: boolean; isExec?: boolean; parts?: MessagePart[] }[]
  >([]);
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

        const runtimes: InvokeConfig['runtimes'] = [];
        const deployedBundles = targetState?.resources?.configBundles ?? {};
        for (const agent of project.runtimes) {
          const state = targetState?.resources?.runtimes?.[agent.name];
          if (!state) continue;

          // Build config bundle baggage if a bundle is associated with this agent
          let baggage: string | undefined;
          const bundleSpec = project.configBundles?.find(b => {
            const keys = Object.keys(b.components ?? {});
            return keys.some(k => k === `{{runtime:${agent.name}}}`);
          });
          if (bundleSpec) {
            const bundleState = deployedBundles[bundleSpec.name];
            if (bundleState?.bundleArn && bundleState?.versionId) {
              baggage = `aws.agentcore.configbundle_arn=${encodeURIComponent(bundleState.bundleArn)},aws.agentcore.configbundle_version=${encodeURIComponent(bundleState.versionId)}`;
            }
          }

          const supportsTraces = agent.entrypoint?.endsWith('.py') || agent.entrypoint?.includes('.py:') || false;
          runtimes.push({
            name: agent.name,
            state,
            modelProvider: undefined,
            networkMode: agent.networkMode,
            protocol: agent.protocol,
            authorizerType: agent.authorizerType,
            baggage,
            supportsTraces,
          });
        }

        if (runtimes.length === 0) {
          setError('No deployed agents found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        setConfig({ runtimes, target: targetConfig, targetName, projectName: project.name });

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
    const agent = config.runtimes[selectedAgent];
    if (!agent) return null;
    return {
      region: config.target.region,
      runtimeArn: agent.state.runtimeArn,
      userId,
      mcpSessionId: mcpSessionIdRef.current,
      headers,
      bearerToken: bearerToken || undefined,
    };
  }, [config, selectedAgent, userId, headers, bearerToken]);

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
    const agent = config.runtimes[selectedAgent];
    if (agent?.authorizerType !== 'CUSTOM_JWT') return;

    // Check if credentials are set up before attempting fetch
    const canFetch = await canFetchRuntimeToken(agent.name);
    if (!canFetch) {
      setTokenFetchState('error');
      setTokenFetchError(
        'No OAuth credentials configured for auto-fetch. Press T to enter a bearer token manually, or re-add the agent with --client-id and --client-secret.'
      );
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

      const agent = config.runtimes[selectedAgent];
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

      // AGUI: structured event streaming with rich rendering
      if (agent.protocol === 'AGUI') {
        const aguiInput = buildAguiRunInput(prompt, sessionId ?? undefined);

        setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
        setPhase('invoking');
        streamingContentRef.current = '';

        logger.logPrompt(prompt, sessionId ?? undefined, userId);

        try {
          const aguiResult = await invokeAguiRuntime(
            {
              region: config.target.region,
              runtimeArn: agent.state.runtimeArn,
              userId,
              logger,
              headers,
              bearerToken: bearerToken || undefined,
            },
            aguiInput
          );

          if (aguiResult.sessionId) {
            setSessionId(aguiResult.sessionId);
            logger.updateSessionId(aguiResult.sessionId);
          }

          const parts: MessagePart[] = [];
          let currentToolCall: { id: string; name: string; args: string } | null = null;

          for await (const event of aguiResult.stream) {
            if (event.type === AguiEventType.TEXT_MESSAGE_CONTENT) {
              const delta = (event as { delta: string }).delta;
              streamingContentRef.current += delta;
              // Accumulate text part — replace instead of mutate for React state safety
              const lastPart = parts[parts.length - 1];
              if (lastPart?.kind === 'text') {
                parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta };
              } else {
                parts.push({ kind: 'text', text: delta });
              }
            } else if (event.type === AguiEventType.TOOL_CALL_START) {
              const tc = event as { toolCallId: string; toolCallName: string };
              currentToolCall = { id: tc.toolCallId, name: tc.toolCallName, args: '' };
            } else if (event.type === AguiEventType.TOOL_CALL_ARGS && currentToolCall) {
              currentToolCall.args += (event as { delta: string }).delta;
            } else if (event.type === AguiEventType.TOOL_CALL_END && currentToolCall) {
              parts.push({
                kind: 'tool_call',
                id: currentToolCall.id,
                name: currentToolCall.name,
                args: currentToolCall.args,
              });
              currentToolCall = null;
            } else if (event.type === AguiEventType.TOOL_CALL_RESULT) {
              const result = event as { toolCallId: string; content: unknown };
              const idx = parts.findIndex(p => p.kind === 'tool_call' && p.id === result.toolCallId);
              if (idx >= 0) {
                const toolPart = parts[idx]!;
                if (toolPart.kind === 'tool_call') {
                  parts[idx] = {
                    ...toolPart,
                    result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
                  };
                }
              }
            } else if (event.type === AguiEventType.REASONING_MESSAGE_CONTENT) {
              const delta = (event as { delta: string }).delta;
              const lastPart = parts[parts.length - 1];
              if (lastPart?.kind === 'reasoning') {
                parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta };
              } else {
                parts.push({ kind: 'reasoning', text: delta });
              }
            } else if (event.type === AguiEventType.RUN_ERROR) {
              const err = event as { message: string; code?: string };
              parts.push({ kind: 'error', message: err.message, code: err.code });
              streamingContentRef.current += `\nError: ${err.message}`;
            }

            const currentContent = streamingContentRef.current;
            const currentParts = [...parts];
            setMessages(prev => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  role: 'assistant',
                  content: currentContent,
                  parts: currentParts,
                };
              }
              return updated;
            });
          }

          logger.logResponse(streamingContentRef.current);
          setPhase('ready');
        } catch (err) {
          const errMsg = getErrorMessage(err);
          logger.logError(err, 'AGUI invoke failed');
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
              {
                region: config.target.region,
                runtimeArn: agent.state.runtimeArn,
                userId,
                sessionId: sessionId ?? undefined,
                logger,
                headers,
              },
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
              baggage: agent.baggage,
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

  const execCommand = useCallback(
    async (command: string) => {
      if (!config || phase === 'invoking') return;

      const agent = config.runtimes[selectedAgent];
      if (!agent) return;

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

      setMessages(prev => [
        ...prev,
        { role: 'user', content: `! ${command}`, isExec: true },
        { role: 'assistant', content: '', isExec: true },
      ]);
      setPhase('invoking');
      streamingContentRef.current = '';

      logger.logPrompt(`exec: ${command}`, sessionId ?? undefined, userId);

      try {
        const result = await executeBashCommand({
          region: config.target.region,
          runtimeArn: agent.state.runtimeArn,
          command,
          sessionId: sessionId ?? undefined,
          headers,
          bearerToken: bearerToken || undefined,
        });

        for await (const event of result.stream) {
          switch (event.type) {
            case 'stdout':
              if (event.data) {
                streamingContentRef.current += event.data;
              }
              break;
            case 'stderr':
              if (event.data) {
                streamingContentRef.current += event.data;
              }
              break;
            case 'stop':
              if (event.exitCode !== undefined && event.exitCode !== 0) {
                streamingContentRef.current += `\n[exit code: ${event.exitCode}${event.status === 'TIMED_OUT' ? ' (timed out)' : ''}]`;
              }
              break;
          }
          const currentContent = streamingContentRef.current;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { ...updated[lastIdx], content: currentContent };
            }
            return updated;
          });
        }

        logger.logResponse(streamingContentRef.current);
        setPhase('ready');
      } catch (err) {
        const errMsg = getErrorMessage(err);
        logger.logError(err, 'exec command failed');

        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { ...updated[lastIdx], content: `Error: ${errMsg}` };
          }
          return updated;
        });
        setPhase('ready');
      }
    },
    [config, selectedAgent, phase, sessionId, userId, headers, bearerToken]
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
    execCommand,
    newSession,
    fetchMcpTools,
  };
}
