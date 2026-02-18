import { ConfigIO } from '../../../../lib';
import type {
  AgentCoreDeployedState,
  AwsDeploymentTarget,
  ModelProvider,
  AgentCoreProjectSpec as _AgentCoreProjectSpec,
} from '../../../../schema';
import { DEFAULT_RUNTIME_USER_ID, invokeAgentRuntimeStreaming } from '../../../aws';
import { getErrorMessage } from '../../../errors';
import { InvokeLogger } from '../../../logging';
import { generateSessionId } from '../../../operations/session';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface InvokeConfig {
  agents: { name: string; state: AgentCoreDeployedState; modelProvider?: ModelProvider }[];
  target: AwsDeploymentTarget;
  targetName: string;
  projectName: string;
}

export interface InvokeFlowOptions {
  initialSessionId?: string;
  initialUserId?: string;
}

export interface InvokeFlowState {
  phase: 'loading' | 'ready' | 'invoking' | 'error';
  config: InvokeConfig | null;
  selectedAgent: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  error: string | null;
  logFilePath: string | null;
  sessionId: string | null;
  userId: string;
  selectAgent: (index: number) => void;
  setUserId: (id: string) => void;
  invoke: (prompt: string) => Promise<void>;
  newSession: () => void;
}

export function useInvokeFlow(options: InvokeFlowOptions = {}): InvokeFlowState {
  const { initialSessionId, initialUserId } = options;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invoking' | 'error'>('loading');
  const [config, setConfig] = useState<InvokeConfig | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string>(initialUserId ?? DEFAULT_RUNTIME_USER_ID);

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
          if (state) {
            agents.push({ name: agent.name, state, modelProvider: agent.modelProvider });
          }
        }

        if (agents.length === 0) {
          setError('No deployed agents found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        setConfig({ agents, target: targetConfig, targetName, projectName: project.name });

        // Initialize session ID - always generate fresh unless explicitly provided
        if (initialSessionId) {
          // Use provided session ID from --session-id flag
          setSessionId(initialSessionId);
        } else {
          // Always generate a new session for fresh invocations
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

  // Track current streaming content to avoid stale closure issues
  const streamingContentRef = useRef('');

  const invoke = useCallback(
    async (prompt: string) => {
      if (!config || phase === 'invoking') return;

      const agent = config.agents[selectedAgent];
      if (!agent) return;

      // Create logger on first invoke or if agent changed
      if (!loggerRef.current) {
        loggerRef.current = new InvokeLogger({
          agentName: agent.name,
          runtimeArn: agent.state.runtimeArn,
          region: config.target.region,
          sessionId: sessionId ?? undefined,
        });
        // Store the absolute path for the LogLink component
        setLogFilePath(loggerRef.current.getAbsoluteLogPath());
      }

      const logger = loggerRef.current;

      // Append new user message and empty assistant message (conversation history is preserved)
      setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
      setPhase('invoking');
      streamingContentRef.current = '';

      logger.logPrompt(prompt, sessionId ?? undefined, userId);

      try {
        const result = await invokeAgentRuntimeStreaming({
          region: config.target.region,
          runtimeArn: agent.state.runtimeArn,
          payload: prompt,
          sessionId: sessionId ?? undefined,
          userId,
          logger, // Pass logger for SSE event debugging
        });

        // Update session ID from response if available (for logging purposes)
        if (result.sessionId) {
          setSessionId(result.sessionId);
          logger.updateSessionId(result.sessionId);
        }

        for await (const chunk of result.stream) {
          streamingContentRef.current += chunk;
          const currentContent = streamingContentRef.current;
          // Update the last message (assistant) with accumulated content
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

        // Update the last message with error
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
    [config, selectedAgent, phase, sessionId, userId]
  );

  const newSession = useCallback(() => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
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
    selectAgent: setSelectedAgent,
    setUserId,
    invoke,
    newSession,
  };
}
