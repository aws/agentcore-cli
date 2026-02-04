import { GradientText, LogLink, Panel, Screen, ScrollableText, SelectList, TextInput } from '../../components';
import { useInvokeFlow } from './useInvokeFlow';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

interface InvokeScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  initialPrompt?: string;
  initialSessionId?: string;
}

type Mode = 'select-agent' | 'chat' | 'input';

export function InvokeScreen({
  isInteractive: _isInteractive,
  onExit,
  initialPrompt,
  initialSessionId,
}: InvokeScreenProps) {
  const { phase, config, selectedAgent, messages, error, logFilePath, sessionId, selectAgent, invoke, newSession } =
    useInvokeFlow({ initialSessionId });
  const [mode, setMode] = useState<Mode>('select-agent');

  // Handle initial prompt - skip agent selection if only one agent
  useEffect(() => {
    if (config && phase === 'ready') {
      if (config.agents.length === 1 && mode === 'select-agent') {
        // Defer setState to avoid cascading renders within effect
        queueMicrotask(() => {
          setMode('input');
        });
        if (initialPrompt && messages.length === 0) {
          void invoke(initialPrompt);
        }
      }
    }
  }, [config, phase, initialPrompt, messages.length, invoke, mode]);

  // Auto-exit when prompt was provided upfront and response completes
  useEffect(() => {
    if (initialPrompt && phase === 'ready' && messages.length > 0) {
      onExit();
    }
  }, [initialPrompt, phase, messages.length, onExit]);

  // Return to input mode after invoke completes
  const prevPhaseRef = React.useRef(phase);
  useEffect(() => {
    if (prevPhaseRef.current === 'invoking' && phase === 'ready' && !initialPrompt) {
      queueMicrotask(() => setMode('input'));
    }
    prevPhaseRef.current = phase;
  }, [phase, initialPrompt]);

  useInput((input, key) => {
    if (phase === 'loading' || phase === 'error' || !config) return;

    if (key.escape || (key.ctrl && input === 'q')) {
      if (mode === 'input') {
        setMode('chat');
      } else if (mode === 'chat' && config.agents.length > 1) {
        setMode('select-agent');
      } else {
        onExit();
      }
      return;
    }

    if (mode === 'select-agent') {
      if (key.upArrow) selectAgent((selectedAgent - 1 + config.agents.length) % config.agents.length);
      if (key.downArrow) selectAgent((selectedAgent + 1) % config.agents.length);
      if (key.return) setMode('input');
    }

    if (mode === 'chat' && input === 'i' && phase === 'ready') {
      setMode('input');
    }

    if (mode === 'chat' && input === 'n' && phase === 'ready') {
      newSession();
    }
  });

  // Error state - show error in main screen
  if (phase === 'error') {
    return (
      <Screen title="AgentCore Invoke" onExit={onExit}>
        <Text color="red">{error}</Text>
      </Screen>
    );
  }

  // Still loading - return null to keep previous screen visible (avoids flash)
  if (phase === 'loading' || !config) {
    return null;
  }

  const agent = config.agents[selectedAgent];
  const agentItems = config.agents.map((a, i) => ({
    id: String(i),
    title: a.name,
    description: `Runtime: ${a.state.runtimeId}`,
  }));

  // Dynamic help text
  const helpText = {
    'select-agent': '↑↓ select · Enter confirm · Esc quit',
    chat: '↑↓ scroll · Esc back',
    input: 'Enter send · Esc cancel',
  }[mode];

  const headerContent = (
    <Box flexDirection="column">
      <Box>
        <Text>Project: </Text>
        <Text color="green">{config.projectName}</Text>
      </Box>
      {mode !== 'select-agent' && (
        <Box>
          <Text>Agent: </Text>
          <Text color="cyan">{agent?.name}</Text>
        </Box>
      )}
      <Box>
        <Text>Target: </Text>
        <Text color="yellow">{config.target.region}</Text>
      </Box>
      {mode !== 'select-agent' && (
        <Box>
          <Text>Session: </Text>
          <Text color="magenta">{sessionId?.slice(0, 8) ?? 'none'}</Text>
        </Box>
      )}
    </Box>
  );

  // Agent selection mode
  if (mode === 'select-agent') {
    return (
      <Screen title="AgentCore Invoke" onExit={onExit} helpText={helpText} headerContent={headerContent}>
        <Panel title="Select Agent" fullWidth>
          <SelectList items={agentItems} selectedIndex={selectedAgent} />
        </Panel>
      </Screen>
    );
  }

  // Get the current message pair (user prompt and assistant response)
  const userMessage = messages.find(m => m.role === 'user');
  const assistantMessage = messages.find(m => m.role === 'assistant');

  // Show messages in both chat and input modes so user can see conversation while typing
  const showMessages = mode === 'chat' || mode === 'input';

  return (
    <Screen title="AgentCore Invoke" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Box flexDirection="column" flexGrow={1}>
        {messages.length === 0 && mode === 'chat' && <Text dimColor>Press &apos;i&apos; to send a message</Text>}

        {/* User prompt */}
        {showMessages && userMessage && (
          <Box marginBottom={1}>
            <Text color="blue">&gt; {userMessage.content}</Text>
          </Box>
        )}

        {/* Assistant response with scrolling */}
        {showMessages && assistantMessage?.content && (
          <Box marginBottom={1} flexDirection="column">
            <ScrollableText
              content={assistantMessage.content}
              color="green"
              isStreaming={phase === 'invoking'}
              isActive={mode === 'chat'}
            />
          </Box>
        )}

        {/* Invoking indicator */}
        {phase === 'invoking' && <GradientText text="Invoking..." />}

        {/* Log file link after response */}
        {logFilePath && messages.length > 0 && phase === 'ready' && (
          <Box marginTop={1}>
            <LogLink filePath={logFilePath} />
          </Box>
        )}

        {/* Input prompt */}
        {mode === 'input' && phase === 'ready' && (
          <TextInput
            prompt=""
            onSubmit={text => {
              setMode('chat');
              void invoke(text);
            }}
            onCancel={() => setMode('chat')}
          />
        )}
      </Box>
    </Screen>
  );
}
