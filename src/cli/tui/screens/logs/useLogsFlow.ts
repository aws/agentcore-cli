import { toError } from '../../../../lib';
import type { AgentContext } from '../../../commands/logs/action';
import { resolveAgentContext } from '../../../commands/logs/action';
import { loadDeployedProjectConfig } from '../../../operations/resolve-agent';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import type { LogEntry } from '../../components/LogPanel';
import { useLogsStream } from '../../hooks/useLogsStream';
import { useEffect, useState } from 'react';

type Phase = 'loading' | 'select-agent' | 'streaming' | 'error';

interface UseLogsFlowResult {
  phase: Phase;
  agents: AgentContext[];
  selectedAgent: AgentContext | undefined;
  loadError: string | undefined;
  selectAgent: (agent: AgentContext) => void;
  logs: LogEntry[];
  isStreaming: boolean;
  streamError: string | undefined;
}

export function useLogsFlow(): UseLogsFlowResult {
  const [phase, setPhase] = useState<Phase>('loading');
  const [agents, setAgents] = useState<AgentContext[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentContext | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  const { logs, isStreaming, error: streamError } = useLogsStream(selectedAgent);

  useEffect(() => {
    const load = async () => {
      const result = await withCommandRunTelemetry('logs', { has_query: false, has_level_filter: false }, async () => {
        let context;
        try {
          context = await loadDeployedProjectConfig();
        } catch (err) {
          return { success: false as const, error: toError(err) };
        }
        const runtimeNames = context.project.runtimes.map(r => r.name);

        if (runtimeNames.length === 0) {
          return { success: false as const, error: new Error('No runtimes defined in agentcore.json') };
        }

        const resolved: AgentContext[] = [];
        for (const name of runtimeNames) {
          const res = resolveAgentContext(context, { runtime: name });
          if (res.success) {
            resolved.push(res.agentContext);
          }
        }

        if (resolved.length === 0) {
          return {
            success: false as const,
            error: new Error('No deployed agents found. Run `agentcore deploy` first.'),
          };
        }

        return { success: true as const, agents: resolved };
      });

      if (!result.success) {
        setLoadError(result.error.message);
        setPhase('error');
        return;
      }

      const resolved = (result as { success: true; agents: AgentContext[] }).agents;
      setAgents(resolved);

      if (resolved.length === 1) {
        setSelectedAgent(resolved[0]);
        setPhase('streaming');
      } else {
        setPhase('select-agent');
      }
    };

    void load();
  }, []);

  const selectAgent = (agent: AgentContext) => {
    setSelectedAgent(agent);
    setPhase('streaming');
  };

  return { phase, agents, selectedAgent, loadError, selectAgent, logs, isStreaming, streamError };
}
