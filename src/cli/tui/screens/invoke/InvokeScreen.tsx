import { buildTraceConsoleUrl } from '../../../operations/traces';
import { GradientText, LogLink, Panel, Screen, SelectList, TextInput } from '../../components';
import { setExitMessage } from '../../exit-message';
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
  /** Custom headers to forward to the agent runtime on every invocation */
  initialHeaders?: Record<string, string>;
  initialBearerToken?: string;
}

type Mode = 'select-agent' | 'chat' | 'input' | 'token-input';

interface ColoredLine {
  text: string;
  color?: string;
}

/**
 * Render conversation as colored lines for scrolling.
 * Each line carries its own color so that word-wrapping preserves it.
 */
function formatConversation(
  messages: {
    role: 'user' | 'assistant';
    content: string;
    isHint?: boolean;
    isExec?: boolean;
    parts?: import('./useInvokeFlow').MessagePart[];
  }[]
): ColoredLine[] {
  const lines: ColoredLine[] = [];

  for (const msg of messages) {
    // Skip empty assistant messages (placeholder before streaming starts)
    if (msg.role === 'assistant' && !msg.content) continue;

    if (msg.role === 'user' && msg.isExec) {
      lines.push({ text: msg.content, color: 'magenta' });
    } else if (msg.role === 'user') {
      lines.push({ text: `> ${msg.content}`, color: 'blue' });
    } else if (msg.isExec) {
      lines.push({ text: msg.content });
    } else if (msg.parts && msg.parts.length > 0) {
      // Rich AGUI rendering: render each part with distinct visual treatment
      for (const part of msg.parts) {
        if (part.kind === 'text') {
          lines.push({ text: part.text, color: 'green' });
        } else if (part.kind === 'tool_call') {
          lines.push({ text: `  [tool] ${part.name}(${part.args})`, color: 'gray' });
          if (part.result) {
            lines.push({ text: `  [result] ${part.result}`, color: 'gray' });
          }
        } else if (part.kind === 'reasoning') {
          lines.push({ text: `  [thinking] ${part.text}`, color: 'gray' });
        } else if (part.kind === 'error') {
          lines.push({ text: `Error: ${part.message}${part.code ? ` (${part.code})` : ''}`, color: 'red' });
        }
      }
    } else {
      lines.push({ text: msg.content, color: 'green' });
    }
    lines.push({ text: '', color: 'green' }); // blank line between messages
  }

  return lines;
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
 * Wrap colored lines for display, preserving color on continuation lines.
 */
function wrapColoredLines(lines: ColoredLine[], maxWidth: number): ColoredLine[] {
  const wrapped: ColoredLine[] = [];
  for (const { text, color } of lines) {
    for (const subLine of text.split('\n')) {
      for (const wrappedLine of wrapLine(subLine, maxWidth)) {
        wrapped.push({ text: wrappedLine, color });
      }
    }
  }
  return wrapped;
}

export function InvokeScreen({
  isInteractive: _isInteractive,
  onExit,
  initialPrompt,
  initialSessionId,
  initialUserId,
  initialHeaders,
  initialBearerToken,
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
    bearerToken,
    tokenFetchState,
    mcpToolsFetched,
    selectAgent,
    setBearerToken,
    fetchBearerToken,
    invoke,
    execCommand,
    newSession,
    fetchMcpTools,
  } = useInvokeFlow({ initialSessionId, initialUserId, headers: initialHeaders, initialBearerToken });
  const [mode, setMode] = useState<Mode>('select-agent');
  const [isExecInput, setIsExecInput] = useState(false);
  const [execInputEmpty, setExecInputEmpty] = useState(true);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [userScrolled, setUserScrolled] = useState(false);
  const { stdout } = useStdout();
  const justCancelledRef = useRef(false);
  const mcpFetchTriggeredRef = useRef(false);

  useEffect(() => {
    if (sessionId && messages.length > 0) {
      const cyan = '\x1b[36m';
      const reset = '\x1b[0m';
      setExitMessage(`To resume this session, run: ${cyan}agentcore invoke --session-id ${sessionId}${reset}`);
    }
  }, [sessionId, messages.length]);

  // Compute auth type early so hooks can reference it
  const currentAgent = config?.runtimes[selectedAgent];
  const isCustomJwt = currentAgent?.authorizerType === 'CUSTOM_JWT';

  // Handle initial prompt - skip agent selection if only one agent
  useEffect(() => {
    if (config && phase === 'ready') {
      if (config.runtimes.length === 1 && mode === 'select-agent') {
        const agent = config.runtimes[0];
        const needsTokenScreen = agent?.authorizerType === 'CUSTOM_JWT' && !bearerToken && !initialBearerToken;
        // Defer setState to avoid cascading renders within effect
        queueMicrotask(() => {
          setMode(needsTokenScreen ? 'token-input' : 'input');
        });
        if (!needsTokenScreen && initialPrompt && messages.length === 0) {
          void invoke(initialPrompt);
        }
      }
    }
  }, [config, phase, initialPrompt, messages.length, invoke, mode, bearerToken, initialBearerToken]);

  // Auto-exit when prompt was provided upfront and response completes
  useEffect(() => {
    if (initialPrompt && phase === 'ready' && messages.length > 0) {
      onExit();
    }
  }, [initialPrompt, phase, messages.length, onExit]);

  // MCP: auto-list tools when agent is selected and ready, show hint after fetch
  useEffect(() => {
    const agent = config?.runtimes[selectedAgent];
    if (agent?.protocol === 'MCP' && phase === 'ready' && mode !== 'select-agent' && !mcpFetchTriggeredRef.current) {
      mcpFetchTriggeredRef.current = true;
      void fetchMcpTools();
    }
  }, [config, selectedAgent, phase, mode, fetchMcpTools]);

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

  // Format conversation content into colored lines
  const coloredLines = useMemo(() => formatConversation(messages), [messages]);

  // Wrap lines for display, preserving color on continuation lines
  const lines = useMemo(() => wrapColoredLines(coloredLines, contentWidth), [coloredLines, contentWidth]);

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
        if (key.upArrow) selectAgent((selectedAgent - 1 + config.runtimes.length) % config.runtimes.length);
        if (key.downArrow) selectAgent((selectedAgent + 1) % config.runtimes.length);
        if (key.return) {
          const chosen = config.runtimes[selectedAgent];
          const needsTokenScreen = chosen?.authorizerType === 'CUSTOM_JWT' && !bearerToken && !initialBearerToken;
          setMode(needsTokenScreen ? 'token-input' : 'input');
        }
        return;
      }

      // Chat mode
      if (mode === 'chat') {
        if (key.escape || (key.ctrl && input === 'q') || (key.ctrl && input === 'c')) {
          if (justCancelledRef.current) {
            justCancelledRef.current = false;
            return;
          }
          if (config.runtimes.length > 1) {
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

  // Auto-fetch bearer token to pre-populate the token screen
  const tokenFetchTriggeredRef = useRef(false);
  useEffect(() => {
    if (
      isCustomJwt &&
      !bearerToken &&
      !initialBearerToken &&
      mode === 'token-input' &&
      tokenFetchState === 'idle' &&
      !tokenFetchTriggeredRef.current
    ) {
      tokenFetchTriggeredRef.current = true;
      void fetchBearerToken();
    }
  }, [isCustomJwt, bearerToken, initialBearerToken, mode, tokenFetchState, fetchBearerToken]);

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

  const agent = config.runtimes[selectedAgent];
  const traceUrl =
    mode !== 'select-agent' && agent?.supportsTraces
      ? buildTraceConsoleUrl({
          region: config.target.region,
          accountId: config.target.account,
          runtimeId: agent.state.runtimeId,
          agentName: agent.name,
        })
      : undefined;
  const agentProtocol = agent?.protocol ?? 'HTTP';

  const agentItems = config.runtimes.map((a, i) => ({
    id: String(i),
    title: a.name,
    description: `${a.protocol && a.protocol !== 'HTTP' ? `${a.protocol} · ` : ''}Runtime: ${a.state.runtimeId}`,
  }));

  const isMcp = agentProtocol === 'MCP';

  // Dynamic help text
  const backOrQuit = config.runtimes.length > 1 ? 'Esc back' : 'Esc quit';
  const helpText =
    mode === 'select-agent'
      ? '↑↓ select · Enter confirm · Esc quit'
      : mode === 'token-input'
        ? 'Enter confirm · Esc skip'
        : mode === 'input'
          ? isExecInput
            ? 'Enter run · Esc cancel · Backspace to exit exec mode'
            : isMcp
              ? 'Enter send · Esc cancel · "list" to refresh tools · ! exec mode'
              : 'Enter send · Esc cancel · ! exec mode'
          : phase === 'invoking'
            ? '↑↓ scroll'
            : messages.length > 0
              ? `↑↓ scroll · Enter invoke · N new session · ${backOrQuit}`
              : isMcp
                ? `Enter to call a tool · N new session · ${backOrQuit}`
                : `Enter to send a message · ${backOrQuit}`;

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
      {mode !== 'select-agent' && agentProtocol !== 'HTTP' && (
        <Box>
          <Text>Protocol: </Text>
          <Text color="cyan">{agentProtocol}</Text>
        </Box>
      )}
      <Box>
        <Text>Target: </Text>
        <Text color="yellow">{config.target.region}</Text>
      </Box>
      {mode !== 'select-agent' && (
        <Box>
          <Text>Session: </Text>
          <Text color="magenta">{sessionId ?? 'none'}</Text>
        </Box>
      )}
      {mode !== 'select-agent' && (
        <Box>
          <Text>User: </Text>
          <Text color="white">{userId}</Text>
        </Box>
      )}
      {mode !== 'select-agent' && isCustomJwt && (
        <Box>
          <Text>Auth: </Text>
          <Text color={bearerToken ? 'green' : 'yellow'}>
            {bearerToken ? 'CUSTOM_JWT (token set)' : 'CUSTOM_JWT (no token)'}
          </Text>
        </Box>
      )}
      {logFilePath && <LogLink filePath={logFilePath} />}
      {traceUrl && (
        <Text color="gray">
          Traces: <Text color="cyan">{traceUrl}</Text>
        </Text>
      )}
      {traceUrl && <Text dimColor>Note: Traces may take 2-3 minutes to appear in CloudWatch</Text>}
      {mode !== 'select-agent' && agent?.networkMode === 'VPC' && (
        <Text color="yellow">
          This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.
        </Text>
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

  // Visible lines for display
  const visibleLines = lines.slice(effectiveOffset, effectiveOffset + displayHeight);

  // Check if the last assistant message is empty (streaming hasn't started yet)
  const lastMessage = messages[messages.length - 1];
  const showThinking = phase === 'invoking' && lastMessage?.role === 'assistant' && !lastMessage.content;

  return (
    <Screen
      title="AgentCore Invoke"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={mode !== 'input'}
    >
      <Box flexDirection="column" flexGrow={1}>
        {/* Conversation display - always visible when there's content */}
        {messages.length > 0 && (
          <Box flexDirection="column" height={needsScroll ? displayHeight : undefined}>
            {visibleLines.map((line, idx) => (
              <Text key={effectiveOffset + idx} color={line.color} wrap="truncate">
                {line.text || ' '}
              </Text>
            ))}
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
        {/* MCP: show loading indicator while fetching tools */}
        {isMcp && !mcpToolsFetched && phase === 'ready' && messages.length === 0 && (
          <GradientText text="Fetching tools..." />
        )}

        {mode === 'chat' && phase === 'ready' && messages.length > 0 && (
          <Box>
            <Text dimColor>{isExecInput ? '! ' : '> '}</Text>
          </Box>
        )}
        {mode === 'chat' && phase === 'ready' && messages.length === 0 && (!isMcp || mcpToolsFetched) && (
          <Text dimColor>{isMcp ? 'Press Enter to call a tool' : 'Press Enter to send a message'}</Text>
        )}
        {mode === 'token-input' && (
          <Box flexDirection="column">
            {tokenFetchState === 'fetching' && <GradientText text="Fetching token..." />}
            {tokenFetchState !== 'fetching' && (
              <Box>
                <Text color="yellow">Bearer token: </Text>
                <TextInput
                  prompt=""
                  hideArrow
                  placeholder="Paste JWT bearer token or press Enter to skip..."
                  initialValue={bearerToken}
                  allowEmpty
                  onSubmit={text => {
                    setBearerToken(text.trim());
                    setMode('input');
                  }}
                  onCancel={() => {
                    setMode('input');
                  }}
                />
              </Box>
            )}
          </Box>
        )}
        {mode === 'input' && phase === 'ready' && (
          <>
            <Box>
              <Text color={isExecInput ? 'magenta' : 'blue'}>{isExecInput ? '! ' : '> '}</Text>
              <TextInput
                prompt=""
                hideArrow
                placeholder={
                  isExecInput
                    ? undefined
                    : isMcp
                      ? 'tool_name {"arg": "value"}'
                      : agentProtocol === 'A2A' || agentProtocol === 'AGUI'
                        ? 'Send a message...'
                        : undefined
                }
                onChange={(value, setValue) => {
                  if (!isExecInput && value.startsWith('!')) {
                    setIsExecInput(true);
                    const rest = value.slice(1);
                    setValue(rest);
                    setExecInputEmpty(!rest);
                  } else {
                    setExecInputEmpty(!value);
                  }
                }}
                onBackspaceEmpty={isExecInput ? () => setIsExecInput(false) : undefined}
                onSubmit={text => {
                  const trimmed = text.trim();
                  if (trimmed) {
                    setMode('chat');
                    setUserScrolled(false);
                    if (isExecInput) {
                      void execCommand(trimmed);
                    } else {
                      void invoke(text);
                    }
                  } else if (!isExecInput) {
                    setMode('chat');
                  }
                }}
                onCancel={() => {
                  if (isExecInput) {
                    setIsExecInput(false);
                  } else {
                    justCancelledRef.current = true;
                    setMode('chat');
                  }
                }}
                onUpArrow={() => scrollUp(1)}
                onDownArrow={() => scrollDown(1)}
              />
            </Box>
            {isExecInput && execInputEmpty && (
              <Text color="magenta" dimColor>
                {' '}
                Run a shell command in the runtime
              </Text>
            )}
          </>
        )}
      </Box>
    </Screen>
  );
}
