import { streamLogs } from '../../aws/cloudwatch';
import type { AgentContext } from '../../commands/logs/action';
import type { LogEntry } from '../components/LogPanel';
import { useEffect, useMemo, useRef, useState } from 'react';

const MAX_LOG_ENTRIES = 1000;

interface UseLogsStreamResult {
  logs: LogEntry[];
  isStreaming: boolean;
  error?: string;
}

function detectLevel(message: string): LogEntry['level'] {
  const lower = message.toLowerCase();
  if (lower.includes('"level":"error"') || lower.includes('[error]') || lower.startsWith('error')) {
    return 'error';
  }
  if (lower.includes('"level":"warn"') || lower.includes('[warn]') || lower.startsWith('warn')) {
    return 'warn';
  }
  if (lower.includes('"level":"info"') || lower.includes('[info]') || lower.startsWith('info')) {
    return 'info';
  }
  return 'system';
}

export function useLogsStream(agentContext: AgentContext | undefined): UseLogsStreamResult {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamState, setStreamState] = useState<'idle' | 'streaming' | 'done'>('idle');
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);

  const isStreaming = useMemo(() => streamState === 'streaming', [streamState]);

  useEffect(() => {
    if (!agentContext) return;

    const ac = new AbortController();
    abortRef.current = ac;

    const run = async () => {
      setStreamState('streaming');
      setError(undefined);
      setLogs([]);

      try {
        for await (const event of streamLogs({
          logGroupName: agentContext.logGroupName,
          region: agentContext.region,
          accountId: agentContext.accountId,
          abortSignal: ac.signal,
        })) {
          if (ac.signal.aborted) break;
          const entry: LogEntry = {
            level: detectLevel(event.message),
            message: `${new Date(event.timestamp).toISOString()}  ${event.message}`,
          };
          setLogs(prev => {
            const next = [...prev, entry];
            return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
          });
        }
      } catch (err: unknown) {
        if (ac.signal.aborted) return;
        const errorName = (err as { name?: string })?.name;
        if (errorName === 'ResourceNotFoundException') {
          setError(`No logs found for agent '${agentContext.agentName}'. Has the agent been invoked?`);
        } else {
          setError((err as Error).message ?? 'Failed to stream logs');
        }
      } finally {
        setStreamState('done');
      }
    };

    void run();

    return () => {
      ac.abort();
      abortRef.current = null;
    };
  }, [agentContext]);

  return { logs, isStreaming, error };
}
