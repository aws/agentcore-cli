import { findConfigRoot, readEnvFile } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { DevLogger } from '../../logging/dev-logger';
import {
  type DevConfig,
  findAvailablePort,
  getDevConfig,
  invokeAgentStreaming,
  killServer,
  loadProjectConfig,
  spawnDevServer,
  waitForPort,
} from '../../operations/dev';
import type { ChildProcess } from 'child_process';
import { useEffect, useMemo, useRef, useState } from 'react';

type ServerStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface LogEntry {
  level: 'info' | 'system' | 'warn' | 'error' | 'response';
  message: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_LOG_ENTRIES = 50;

export function useDevServer(options: { workingDir: string; port: number; agentName?: string }) {
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

  const serverRef = useRef<ChildProcess | null>(null);
  const loggerRef = useRef<DevLogger | null>(null);
  // Track instance ID to ignore callbacks from stale server instances
  const instanceIdRef = useRef(0);
  // Track if we're intentionally restarting to ignore exit callbacks
  const isRestartingRef = useRef(false);

  const addLog = (level: LogEntry['level'], message: string) => {
    setLogs(prev => [...prev.slice(-MAX_LOG_ENTRIES), { level, message }]);
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
        setEnvVars(vars);
      }

      setConfigLoaded(true);
    };
    void load();
  }, [options.workingDir]);

  const config: DevConfig | null = useMemo(() => {
    if (!project) return null;
    return getDevConfig(options.workingDir, project, configRoot, options.agentName);
  }, [options.workingDir, project, configRoot, options.agentName]);

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
      const port = isRestart && portFree ? actualPortRef.current : await findAvailablePort(targetPort);
      if (!isRestart && port !== targetPort) {
        addLog('warn', `Port ${targetPort} in use, using ${port}`);
      }
      actualPortRef.current = port;
      setActualPort(port);

      let serverReady = false;
      serverRef.current = spawnDevServer({
        module: config.module,
        cwd: config.directory,
        port,
        isPython: config.isPython,
        envVars,
        callbacks: {
          onLog: (level, message) => {
            // Ignore callbacks from stale server instances
            if (instanceIdRef.current !== currentInstanceId) return;

            // Detect when server is actually ready (only once)
            if (
              !serverReady &&
              (message.includes('Application startup complete') || message.includes('Uvicorn running'))
            ) {
              serverReady = true;
              setStatus('running');
              addLog('system', `Server ready at http://localhost:${port}/invocations`);
            } else {
              addLog(level, message);
            }
          },
          onExit: code => {
            // Ignore exit events from stale server instances
            if (instanceIdRef.current !== currentInstanceId) return;

            // Ignore exit events when intentionally restarting
            if (isRestartingRef.current) {
              isRestartingRef.current = false;
              return;
            }

            setStatus(code === 0 ? 'stopped' : 'error');
            addLog('system', `Server exited (code ${code})`);
          },
        },
      });
    };

    void startServer();
    return () => {
      killServer(serverRef.current);
      loggerRef.current?.finalize();
    };
  }, [configLoaded, config, targetPort, restartTrigger, envVars, options.workingDir]);

  const invoke = async (message: string) => {
    // Add user message to conversation
    setConversation(prev => [...prev, { role: 'user', content: message }]);
    setStreamingResponse(null);
    setIsStreaming(true);

    let responseContent = '';

    try {
      // Pass logger to capture raw SSE events for debugging
      const stream = invokeAgentStreaming({
        port: actualPort,
        message,
        logger: loggerRef.current ?? undefined,
      });

      for await (const chunk of stream) {
        responseContent += chunk;
        setStreamingResponse(responseContent);
      }

      // Add assistant response to conversation
      setConversation(prev => [...prev, { role: 'assistant', content: responseContent }]);
      setStreamingResponse(null);

      // Log final response to file
      loggerRef.current?.log('system', `→ ${message}`);
      loggerRef.current?.log('response', responseContent);
    } catch (err) {
      const errorMsg = `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      addLog('error', errorMsg);
      // Add error as assistant message
      setConversation(prev => [...prev, { role: 'assistant', content: errorMsg }]);
      setStreamingResponse(null);
    } finally {
      setIsStreaming(false);
    }
  };

  const clearLogs = () => setLogs([]);

  const restart = () => {
    addLog('system', 'Restarting server...');
    isRestartingRef.current = true;
    killServer(serverRef.current);
    setStatus('starting');
    setRestartTrigger(t => t + 1);
  };

  const stop = () => {
    killServer(serverRef.current);
    loggerRef.current?.finalize();
    setStatus('stopped');
  };

  const clearConversation = () => {
    setConversation([]);
    setStreamingResponse(null);
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
  };
}
