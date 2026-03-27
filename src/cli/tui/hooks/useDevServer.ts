import { findConfigRoot, readEnvFile } from '../../../lib';
import type { AgentCoreProjectSpec, ProtocolMode } from '../../../schema';
import { DevLogger } from '../../logging/dev-logger';
import {
  type A2AAgentCard,
  ConnectionError,
  type DevConfig,
  DevServer,
  type LogLevel,
  type McpTool,
  ServerError,
  callMcpTool,
  createDevServer,
  fetchA2AAgentCard,
  findAvailablePort,
  getDevConfig,
  getEndpointUrl,
  invokeA2AStreaming,
  invokeAgentStreaming,
  listMcpTools,
  loadProjectConfig,
  waitForPort,
} from '../../operations/dev';
import { getGatewayEnvVars } from '../../operations/dev/gateway-env.js';
import { formatMcpToolList } from '../../operations/dev/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ServerStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface LogEntry {
  level: 'info' | 'system' | 'warn' | 'error' | 'response';
  message: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
  isHint?: boolean;
}

const MAX_LOG_ENTRIES = 50;

export function useDevServer(options: {
  workingDir: string;
  port: number;
  agentName?: string;
  onReady?: () => void;
  headers?: Record<string, string>;
}) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<ServerStatus>('starting');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [streamingResponse, setStreamingResponse] = useState<string | null>(null);
  const [project, setProject] = useState<AgentCoreProjectSpec | null>(null);
  const [configRoot, setConfigRoot] = useState<string | undefined>(undefined);
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [configLoaded, setConfigLoaded] = useState(false);
  const [targetPort] = useState(options.port);
  const [actualPort, setActualPort] = useState(targetPort);
  const actualPortRef = useRef(targetPort);
  const [restartTrigger, setRestartTrigger] = useState(0);

  // MCP session state
  const mcpSessionIdRef = useRef<string | undefined>(undefined);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);

  // A2A state
  const [a2aAgentCard, setA2aAgentCard] = useState<A2AAgentCard | null>(null);
  const [a2aStatus, setA2aStatus] = useState<string | null>(null);

  const serverRef = useRef<DevServer | null>(null);
  const loggerRef = useRef<DevLogger | null>(null);
  const logsRef = useRef<LogEntry[]>([]);
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  // Track instance ID to ignore callbacks from stale server instances
  const instanceIdRef = useRef(0);
  // Track if we're intentionally restarting to ignore exit callbacks
  const isRestartingRef = useRef(false);

  const addLog = (level: LogEntry['level'], message: string) => {
    setLogs(prev => {
      const next = [...prev.slice(-MAX_LOG_ENTRIES), { level, message }];
      logsRef.current = next;
      return next;
    });
    // Also log to file (DevLogger filters to only important logs)
    loggerRef.current?.log(level, message);
  };

  // Load config and env vars on mount
  useEffect(() => {
    const load = async () => {
      const root = findConfigRoot(options.workingDir);
      setConfigRoot(root ?? undefined);
      const cfg = await loadProjectConfig(options.workingDir);
      setProject(cfg);

      // Load env vars from agentcore/.env
      if (root) {
        const vars = await readEnvFile(root);
        const gatewayEnvVars = await getGatewayEnvVars();
        // Gateway env vars go first, .env.local overrides take precedence
        const mergedEnvVars = { ...gatewayEnvVars, ...vars };
        setEnvVars(mergedEnvVars);
      }

      setConfigLoaded(true);
    };
    void load();
  }, [options.workingDir]);

  const config: DevConfig | null = useMemo(() => {
    if (!project || !options.agentName) {
      return null;
    }
    return getDevConfig(options.workingDir, project, configRoot, options.agentName);
  }, [options.workingDir, project, configRoot, options.agentName]);

  const protocol: ProtocolMode = config?.protocol ?? 'HTTP';

  // Start server when config is loaded
  useEffect(() => {
    if (!configLoaded || !config) return;

    // Increment instance ID to track this server instance
    instanceIdRef.current += 1;
    const currentInstanceId = instanceIdRef.current;

    const startServer = async () => {
      // Initialize file logger for this dev session
      loggerRef.current = new DevLogger({
        baseDir: options.workingDir,
        agentName: config.agentName,
      });

      // A2A servers always use port 9000, MCP servers use port 8000 (framework defaults, not configurable via env)
      const isA2A = config.protocol === 'A2A';
      const isMcp = config.protocol === 'MCP';
      const fixedPort = isA2A ? 9000 : isMcp ? 8000 : targetPort;

      // On restart, reuse the same port. On initial start, find an available port.
      // If restart times out waiting for port, fall back to finding a new one.
      const isRestart = restartTrigger > 0;
      let portFree = true;
      if (isRestart) {
        portFree = await waitForPort(actualPortRef.current);
        if (!portFree) {
          addLog('warn', `Port ${actualPortRef.current} not released, finding new port`);
        }
      }

      let port: number;
      if (isA2A || isMcp) {
        // A2A/MCP must use their fixed ports; check availability but don't auto-assign another
        const available = await findAvailablePort(fixedPort);
        if (available !== fixedPort) {
          addLog('error', `Port ${fixedPort} is in use. ${config.protocol} agents require port ${fixedPort}.`);
          setStatus('error');
          return;
        }
        port = fixedPort;
      } else {
        port = isRestart && portFree ? actualPortRef.current : await findAvailablePort(fixedPort);
        if (!isRestart && port !== fixedPort) {
          addLog('warn', `Port ${fixedPort} in use, using ${port}`);
        }
      }
      actualPortRef.current = port;
      setActualPort(port);

      let serverReady = false;
      const callbacks = {
        onLog: (level: LogLevel, message: string) => {
          // Ignore callbacks from stale server instances
          if (instanceIdRef.current !== currentInstanceId) return;

          // Detect when server is actually ready (only once)
          if (
            !serverReady &&
            (message.includes('Application startup complete') || message.includes('Uvicorn running'))
          ) {
            serverReady = true;
            setStatus('running');
            onReadyRef.current?.();

            const endpointUrl = getEndpointUrl(port, config.protocol);
            addLog('system', `Server ready at ${endpointUrl}`);
          } else {
            addLog(level, message);
          }
        },
        onExit: (code: number | null) => {
          // Ignore exit events from stale server instances
          if (instanceIdRef.current !== currentInstanceId) return;

          // Ignore exit events when intentionally restarting
          if (isRestartingRef.current) {
            isRestartingRef.current = false;
            return;
          }

          setStatus(code === 0 ? 'stopped' : 'error');
          addLog(
            'system',
            code !== 0 && code !== null
              ? `Server crashed (code ${code}) — check logs above for details`
              : `Server exited (code ${code})`
          );
        },
      };

      const server = createDevServer(config, { port, envVars, callbacks });
      serverRef.current = server;
      await server.start();
    };

    void startServer();
    return () => {
      serverRef.current?.kill();
      loggerRef.current?.finalize();
    };
  }, [
    configLoaded,
    config,
    config?.agentName,
    config?.module,
    config?.directory,
    config?.isPython,
    options.workingDir,
    targetPort,
    restartTrigger,
    envVars,
  ]);

  // MCP: auto-list tools when server becomes ready
  const mcpToolsRef = useRef<McpTool[]>([]);

  // A2A: fetch agent card when server becomes ready
  const fetchAgentCard = useCallback(async () => {
    try {
      const card = await fetchA2AAgentCard(actualPortRef.current, loggerRef.current ?? undefined);
      setA2aAgentCard(card);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog('warn', `Failed to fetch agent card: ${errMsg}`);
    }
  }, []);

  const fetchMcpTools = useCallback(async () => {
    try {
      const result = await listMcpTools(actualPortRef.current, loggerRef.current ?? undefined, options.headers);
      setMcpTools(result.tools);
      mcpToolsRef.current = result.tools;
      mcpSessionIdRef.current = result.sessionId;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog('error', `Failed to list MCP tools: ${errMsg}`);
      setMcpTools([]);
      mcpToolsRef.current = [];
    }
  }, [options.headers]);

  const invoke = async (message: string) => {
    // MCP: parse tool calls from chat input
    if (protocol === 'MCP') {
      if (message.trim().toLowerCase() === 'list') {
        setConversation(prev => [...prev, { role: 'user', content: message }]);
        await fetchMcpTools();
        // Use ref for fresh value after async fetch
        const tools = mcpToolsRef.current;
        setConversation(prev => [...prev, { role: 'assistant', content: formatMcpToolList(tools), isHint: true }]);
        return;
      }

      // Parse "tool_name {json_args}" or just "tool_name"
      const match = /^(\S+)\s*(.*)/.exec(message);
      if (!match) return;
      const toolName = match[1]!;
      const argsStr = match[2]?.trim() ?? '';

      setConversation(prev => [...prev, { role: 'user', content: message }]);
      setIsStreaming(true);

      try {
        let args: Record<string, unknown> = {};
        if (argsStr) {
          args = JSON.parse(argsStr) as Record<string, unknown>;
        }
        const result = await callMcpTool(
          actualPort,
          toolName,
          args,
          mcpSessionIdRef.current,
          loggerRef.current ?? undefined,
          options.headers
        );
        setConversation(prev => [...prev, { role: 'assistant', content: `Result: ${result}` }]);

        loggerRef.current?.log('system', `MCP call: ${toolName}(${argsStr})`);
        loggerRef.current?.log('response', result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog('error', `MCP call failed: ${errMsg}`);
        setConversation(prev => [...prev, { role: 'assistant', content: errMsg, isError: true }]);
      } finally {
        setIsStreaming(false);
      }
      return;
    }

    // HTTP and A2A: chat-style invoke
    setConversation(prev => [...prev, { role: 'user', content: message }]);
    setStreamingResponse(null);
    setIsStreaming(true);

    let responseContent = '';

    try {
      // Select streaming function based on protocol
      if (protocol === 'A2A') {
        setA2aStatus(null);
      }
      const streamFn =
        protocol === 'A2A'
          ? invokeA2AStreaming({
              port: actualPort,
              message,
              logger: loggerRef.current ?? undefined,
              onStatus: setA2aStatus,
              headers: options.headers,
            })
          : invokeAgentStreaming({
              port: actualPort,
              message,
              logger: loggerRef.current ?? undefined,
              headers: options.headers,
            });

      for await (const chunk of streamFn) {
        responseContent += chunk;
        setStreamingResponse(responseContent);
      }

      // Add assistant response to conversation
      setConversation(prev => [...prev, { role: 'assistant', content: responseContent }]);
      setStreamingResponse(null);

      // Log final response to file
      loggerRef.current?.log('system', `\u2192 ${message}`);
      loggerRef.current?.log('response', responseContent);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Unknown error';

      let errorMsg: string;
      let showHint = false;
      if (err instanceof ServerError) {
        // HTTP error — use the response body directly (avoids stderr race condition)
        errorMsg = err.message || `Server error (${err.statusCode})`;
        showHint = true;
      } else if (err instanceof ConnectionError) {
        // Connection failed after retries — check stderr logs for crash context
        const recentErrors = logsRef.current
          .filter(l => l.level === 'error')
          .slice(-5)
          .map(l => l.message);
        errorMsg = recentErrors.length > 0 ? recentErrors.join('\n') : `Connection failed: ${rawMsg}`;
        showHint = recentErrors.length > 0;
      } else {
        errorMsg = `Failed: ${rawMsg}`;
      }

      addLog('error', `Failed: ${rawMsg}`);
      const messages: ConversationMessage[] = [{ role: 'assistant', content: errorMsg, isError: true }];
      if (showHint) {
        messages.push({ role: 'assistant', content: 'See logs for full stack trace.', isHint: true });
      }
      setConversation(prev => [...prev, ...messages]);
      setStreamingResponse(null);
    } finally {
      setIsStreaming(false);
      setA2aStatus(null);
    }
  };

  const clearLogs = () => {
    setLogs([]);
    logsRef.current = [];
  };

  const restart = () => {
    addLog('system', 'Restarting server...');
    isRestartingRef.current = true;
    serverRef.current?.kill();
    setStatus('starting');
    setRestartTrigger(t => t + 1);
  };

  const stop = () => {
    serverRef.current?.kill();
    loggerRef.current?.finalize();
    setStatus('stopped');
  };

  const clearConversation = () => {
    setConversation([]);
    setStreamingResponse(null);
  };

  const showMcpHint = () => {
    const tools = mcpToolsRef.current;
    if (tools.length > 0) {
      setConversation(prev => [...prev, { role: 'assistant', content: formatMcpToolList(tools), isHint: true }]);
    }
  };

  return {
    logs,
    status,
    isStreaming,
    conversation,
    streamingResponse,
    config,
    configLoaded,
    actualPort,
    invoke,
    clearLogs,
    clearConversation,
    restart,
    stop,
    logFilePath: loggerRef.current?.getRelativeLogPath(),
    hasMemory: (project?.memories?.length ?? 0) > 0,
    hasVpc: project?.runtimes.find(a => a.name === config?.agentName)?.networkMode === 'VPC',
    modelProvider: undefined,
    protocol,
    mcpTools,
    fetchMcpTools,
    showMcpHint,
    a2aAgentCard,
    a2aStatus,
    fetchAgentCard,
  };
}
