import { GradientText, LogLink, Panel, Screen, SelectList, TextInput } from '../../components';
import { useInvokeFlow } from './useInvokeFlow';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface InvokeScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  initialPrompt?: string;
  initialSessionId?: string;
  initialUserId?: string;
}

type Mode = 'select-agent' | 'chat' | 'input';

/**
 * Render conversation messages as a single string for scrolling.
 */
function formatConversation(messages: { role: 'user' | 'assistant'; content: string }[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    // Skip empty assistant messages (placeholder before streaming starts)
    if (msg.role === 'assistant' && !msg.content) continue;

    if (msg.role === 'user') {
      lines.push(`> ${msg.content}`);
    } else {
      lines.push(msg.content);
    }
    lines.push(''); // blank line between messages
  }

  return lines.join('\n');
}

/**
 * Word-wrap a single line to fit within maxWidth.
 */
function wrapLine(line: string, maxWidth: number): string[] {
  if (!line) return [''];
  if (line.length <= maxWidth) return [line];

  const wrapped: string[] = [];
  const words = line.split(' ');
  let currentLine = '';

  for (const word of words) {
    if (word.length > maxWidth) {
      if (currentLine) {
        wrapped.push(currentLine);
        currentLine = '';
      }
      for (let i = 0; i < word.length; i += maxWidth) {
        wrapped.push(word.slice(i, i + maxWidth));
      }
      continue;
    }

    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        wrapped.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    wrapped.push(currentLine);
  }

  return wrapped.length > 0 ? wrapped : [''];
}

/**
 * Wrap multi-line text to fit within maxWidth.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapLine(line, maxWidth));
  }
  return wrapped;
}

export function InvokeScreen({
  isInteractive: _isInteractive,
  onExit,
  initialPrompt,
  initialSessionId,
  initialUserId,
}: InvokeScreenProps) {
  const {
    phase,
    config,
    selectedAgent,
    messages,
    error,
    logFilePath,
    sessionId,
    userId,
    selectAgent,
    invoke,
    newSession,
  } = useInvokeFlow({ initialSessionId, initialUserId });
  const [mode, setMode] = useState<Mode>('select-agent');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [userScrolled, setUserScrolled] = useState(false);
  const { stdout } = useStdout();
  const justCancelledRef = useRef(false);

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
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    if (prevPhaseRef.current === 'invoking' && phase === 'ready' && !initialPrompt) {
      queueMicrotask(() => setMode('input'));
    }
    prevPhaseRef.current = phase;
  }, [phase, initialPrompt]);

  // Calculate available height for conversation display
  const terminalHeight = stdout?.rows ?? 24;
  const terminalWidth = stdout?.columns ?? 80;
  const baseHeight = Math.max(5, terminalHeight - 12);
  const displayHeight = mode === 'input' ? Math.max(3, baseHeight - 2) : baseHeight;
  const contentWidth = Math.max(40, terminalWidth - 4);

  // Format conversation content
  const conversationText = useMemo(() => formatConversation(messages), [messages]);

  // Wrap text for display
  const lines = useMemo(() => wrapText(conversationText, contentWidth), [conversationText, contentWidth]);

  const totalLines = lines.length;
  const maxScroll = Math.max(0, totalLines - displayHeight);
  const needsScroll = totalLines > displayHeight;

  // Auto-scroll to bottom when user hasn't manually scrolled up
  const effectiveOffset = useMemo(() => {
    if (totalLines === 0) return 0;
    if (!userScrolled && totalLines > displayHeight) return maxScroll;
    return Math.min(scrollOffset, maxScroll);
  }, [totalLines, userScrolled, scrollOffset, maxScroll, displayHeight]);

  const scrollUp = useCallback(
    (amount = 1) => {
      if (!needsScroll) return;
      setUserScrolled(true);
      setScrollOffset(prev => {
        const current = userScrolled ? prev : maxScroll;
        return Math.max(0, current - amount);
      });
    },
    [needsScroll, userScrolled, maxScroll]
  );

  const scrollDown = useCallback(
    (amount = 1) => {
      if (!needsScroll) return;
      setScrollOffset(prev => {
        const next = Math.min(maxScroll, prev + amount);
        if (next >= maxScroll) {
          setUserScrolled(false);
        }
        return next;
      });
    },
    [needsScroll, maxScroll]
  );

  useInput(
    (input, key) => {
      if (phase === 'loading' || phase === 'error' || !config) return;

      // Agent selection mode
      if (mode === 'select-agent') {
        if (key.escape || (key.ctrl && input === 'q')) {
          onExit();
          return;
        }
        if (key.upArrow) selectAgent((selectedAgent - 1 + config.agents.length) % config.agents.length);
        if (key.downArrow) selectAgent((selectedAgent + 1) % config.agents.length);
        if (key.return) setMode('input');
        return;
      }

      // Chat mode
      if (mode === 'chat') {
        if (key.escape || (key.ctrl && input === 'q') || (key.ctrl && input === 'c')) {
          if (justCancelledRef.current) {
            justCancelledRef.current = false;
            return;
          }
          if (config.agents.length > 1) {
            setMode('select-agent');
            return;
          }
          onExit();
          return;
        }

        justCancelledRef.current = false;

        // Enter or 'i' to start typing (only when not invoking)
        if ((key.return || input === 'i') && phase === 'ready') {
          setMode('input');
          return;
        }

        // New session
        if (input === 'n' && phase === 'ready') {
          newSession();
          setScrollOffset(0);
          setUserScrolled(false);
          return;
        }

        // Scroll controls
        if (key.upArrow) scrollUp(1);
        else if (key.downArrow) scrollDown(1);
        else if (key.pageUp) scrollUp(displayHeight);
        else if (key.pageDown) scrollDown(displayHeight);
      }
    },
    { isActive: mode === 'chat' || mode === 'select-agent' }
  );

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
  const helpText =
    mode === 'select-agent'
      ? '↑↓ select · Enter confirm · Esc quit'
      : mode === 'input'
        ? 'Enter send · Esc cancel'
        : phase === 'invoking'
          ? '↑↓ scroll'
          : messages.length > 0
            ? `↑↓ scroll · Enter invoke · N new session · ${config.agents.length > 1 ? 'Esc back' : 'Esc quit'}`
            : `Enter to send a message · ${config.agents.length > 1 ? 'Esc back' : 'Esc quit'}`;

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
      {mode !== 'select-agent' && agent?.modelProvider && (
        <Box>
          <Text>Provider: </Text>
          <Text color="cyan">{agent.modelProvider}</Text>
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
      {mode !== 'select-agent' && (
        <Box>
          <Text>User: </Text>
          <Text color="white">{userId}</Text>
        </Box>
      )}
      {logFilePath && <LogLink filePath={logFilePath} />}
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

  // Visible lines for display
  const visibleLines = lines.slice(effectiveOffset, effectiveOffset + displayHeight);

  // Check if the last assistant message is empty (streaming hasn't started yet)
  const lastMessage = messages[messages.length - 1];
  const showThinking = phase === 'invoking' && lastMessage?.role === 'assistant' && !lastMessage.content;

  return (
    <Screen title="AgentCore Invoke" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Box flexDirection="column" flexGrow={1}>
        {/* Conversation display - always visible when there's content */}
        {messages.length > 0 && (
          <Box flexDirection="column" height={needsScroll ? displayHeight : undefined}>
            {visibleLines.map((line, idx) => {
              // Detect user messages (start with "> ")
              const isUserMessage = line.startsWith('> ');
              return (
                <Text key={effectiveOffset + idx} color={isUserMessage ? 'blue' : 'green'} wrap="truncate">
                  {line || ' '}
                </Text>
              );
            })}
            {/* Thinking indicator - shows while waiting for response to start */}
            {showThinking && <GradientText text="Thinking..." />}
          </Box>
        )}

        {/* Scroll indicator */}
        {needsScroll && (
          <Text dimColor>
            [{effectiveOffset + 1}-{Math.min(effectiveOffset + displayHeight, totalLines)} of {totalLines}]
          </Text>
        )}

        {/* Input area */}
        {mode === 'chat' && phase === 'ready' && messages.length > 0 && (
          <Box>
            <Text dimColor>&gt; </Text>
          </Box>
        )}
        {mode === 'chat' && phase === 'ready' && messages.length === 0 && (
          <Text dimColor>Press Enter to send a message</Text>
        )}
        {mode === 'input' && phase === 'ready' && (
          <Box>
            <Text color="blue">&gt; </Text>
            <TextInput
              prompt=""
              hideArrow
              onSubmit={text => {
                if (text.trim()) {
                  setMode('chat');
                  setUserScrolled(false);
                  void invoke(text);
                } else {
                  setMode('chat');
                }
              }}
              onCancel={() => {
                justCancelledRef.current = true;
                setMode('chat');
              }}
              onUpArrow={() => scrollUp(1)}
              onDownArrow={() => scrollDown(1)}
            />
          </Box>
        )}
      </Box>
    </Screen>
  );
}
