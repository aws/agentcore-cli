import type { AgentEnvSpec } from '../../../../schema';
import { getDevSupportedAgents, loadProjectConfig } from '../../../operations/dev';
import { GradientText, LogLink, Panel, Screen, SelectList, TextInput } from '../../components';
import { type ConversationMessage, useDevServer } from '../../hooks/useDevServer';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'select-agent' | 'chat' | 'input';

interface DevScreenProps {
  onBack: () => void;
  workingDir?: string;
  port?: number;
  /** Pre-selected agent name (from CLI --agent flag) */
  agentName?: string;
}

interface ColoredLine {
  text: string;
  color: string;
}

/**
 * Render conversation as colored lines for scrolling.
 * Each line carries its own color so that word-wrapping preserves it.
 */
function formatConversation(
  conversation: ConversationMessage[],
  streamingResponse: string | null,
  isStreaming: boolean
): ColoredLine[] {
  const lines: ColoredLine[] = [];

  for (const msg of conversation) {
    if (msg.role === 'user') {
      lines.push({ text: `> ${msg.content}`, color: 'blue' });
    } else if (msg.isError) {
      for (const errLine of msg.content.split('\n')) {
        lines.push({ text: errLine, color: 'red' });
      }
    } else if (msg.isHint) {
      lines.push({ text: msg.content, color: 'cyan' });
    } else {
      lines.push({ text: msg.content, color: 'green' });
    }
    lines.push({ text: '', color: 'green' }); // blank line between messages
  }

  // Add streaming response if in progress
  if (isStreaming && streamingResponse) {
    lines.push({ text: streamingResponse, color: 'green' });
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
 * Wrap colored lines to fit within maxWidth, preserving color on continuation lines.
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

export function DevScreen(props: DevScreenProps) {
  const [mode, setMode] = useState<Mode>('select-agent');
  const [isExiting, setIsExiting] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  // Track if user manually scrolled up (false = auto-scroll to bottom)
  const [userScrolled, setUserScrolled] = useState(false);
  const { stdout } = useStdout();
  // Track when we just cancelled input to prevent double-escape quit
  const justCancelledRef = useRef(false);

  // Agent selection state
  const [supportedAgents, setSupportedAgents] = useState<AgentEnvSpec[]>([]);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>(props.agentName);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [noAgentsError, setNoAgentsError] = useState(false);

  const workingDir = props.workingDir ?? process.cwd();

  // Load project and get supported agents
  useEffect(() => {
    const load = async () => {
      const project = await loadProjectConfig(workingDir);
      const agents = getDevSupportedAgents(project);
      setSupportedAgents(agents);

      // If agent name was provided via CLI, validate it
      if (props.agentName) {
        const found = agents.find(a => a.name === props.agentName);
        if (found) {
          setSelectedAgentName(props.agentName);
          setMode('chat');
        } else if (agents.length > 0) {
          // Agent not found or not supported, show selection
          setSelectedAgentName(undefined);
        }
      } else if (agents.length === 1 && agents[0]) {
        // Auto-select if only one agent
        setSelectedAgentName(agents[0].name);
        setMode('chat');
      } else if (agents.length === 0) {
        // No supported agents, show error screen
        setNoAgentsError(true);
      }

      setAgentsLoaded(true);
    };
    void load();
  }, [workingDir, props.agentName]);

  const onServerReady = useCallback(() => setMode(prev => (prev === 'chat' ? 'input' : prev)), []);

  const {
    logs,
    status,
    isStreaming,
    conversation,
    streamingResponse,
    config,
    configLoaded,
    actualPort,
    invoke,
    clearConversation,
    restart,
    stop,
    logFilePath,
    hasMemory,
    modelProvider,
  } = useDevServer({
    workingDir,
    port: props.port ?? 8080,
    agentName: selectedAgentName,
    onReady: onServerReady,
  });

  // Handle exit with brief "stopping" message
  const handleExit = useCallback(() => {
    if (isExiting) return; // Prevent double-exit
    setIsExiting(true);
    stop();
    setTimeout(() => {
      props.onBack();
    }, 1000);
  }, [props, stop, isExiting]);

  // Calculate available height for conversation display
  const terminalHeight = stdout?.rows ?? 24;
  const terminalWidth = stdout?.columns ?? 80;
  // Reserve lines for: header (4-5), help text (1), input area when active (2), margins
  // Reduce height when in input mode to make room for input field
  const baseHeight = Math.max(5, terminalHeight - 12);
  const displayHeight = mode === 'input' ? Math.max(3, baseHeight - 2) : baseHeight;
  const contentWidth = Math.max(40, terminalWidth - 4);

  // Format conversation content into colored lines
  const coloredLines = useMemo(
    () => formatConversation(conversation, streamingResponse, isStreaming),
    [conversation, streamingResponse, isStreaming]
  );

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
        // scrollOffset state starts at 0, but the view shows the bottom when userScrolled is false.
        // So on first scroll up, we need to start from maxScroll (bottom) not prev (which is 0).
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

  const handleInvoke = async (message: string) => {
    setMode('chat');
    setUserScrolled(false); // Auto-scroll for new message
    await invoke(message);
    setMode('input'); // Return to input mode after invoke completes
  };

  useInput(
    (input, key) => {
      // Agent selection mode
      if (mode === 'select-agent') {
        if (key.escape || (key.ctrl && input === 'q')) {
          handleExit();
          return;
        }
        if (key.upArrow || input === 'k') {
          setSelectedAgentIndex(prev => (prev - 1 + supportedAgents.length) % supportedAgents.length);
        }
        if (key.downArrow || input === 'j') {
          setSelectedAgentIndex(prev => (prev + 1) % supportedAgents.length);
        }
        if (key.return) {
          const agent = supportedAgents[selectedAgentIndex];
          if (agent) {
            setSelectedAgentName(agent.name);
            setMode('chat');
          }
        }
        return;
      }

      // In chat mode
      if (mode === 'chat') {
        // Esc or Ctrl+Q to quit (but skip if we just cancelled from input mode)
        if (key.escape || (key.ctrl && input === 'q') || (key.ctrl && input === 'c')) {
          if (justCancelledRef.current) {
            // Skip this escape - it's from the input cancel
            justCancelledRef.current = false;
            return;
          }
          // If multiple agents, go back to agent selection
          if (supportedAgents.length > 1) {
            stop();
            setMode('select-agent');
            setSelectedAgentName(undefined);
            clearConversation();
            return;
          }
          handleExit();
          return;
        }

        // Clear the flag on any other key
        justCancelledRef.current = false;

        // Enter to start typing (only when not streaming and server is running)
        if (key.return && !isStreaming && status === 'running') {
          setMode('input');
          return;
        }

        // Scroll controls
        if (key.upArrow) {
          scrollUp(1);
        } else if (key.downArrow) {
          scrollDown(1);
        } else if (key.pageUp) {
          scrollUp(displayHeight);
        } else if (key.pageDown) {
          scrollDown(displayHeight);
        }

        // Other hotkeys (only when not streaming)
        if (!isStreaming) {
          if (input === 'c') {
            clearConversation();
            setScrollOffset(0);
            setUserScrolled(false);
            return;
          }
          if (key.ctrl && input === 'r' && status !== 'starting') {
            restart();
            return;
          }
        }
      }
    },
    { isActive: mode === 'chat' || mode === 'select-agent' }
  );

  // Return null while loading
  if (!agentsLoaded || (mode !== 'select-agent' && !noAgentsError && (!configLoaded || !config))) {
    return null;
  }

  // Show error screen if no agents are defined
  if (noAgentsError) {
    return (
      <Screen title="Dev Server" onExit={props.onBack} helpText="Esc quit">
        <Box flexDirection="column">
          <Text color="red">No agents defined in project.</Text>
          <Text>Dev mode requires at least one Python agent with an entrypoint.</Text>
          <Text>
            Run <Text color="blue">agentcore add agent</Text> to create one.
          </Text>
        </Box>
      </Screen>
    );
  }

  const statusColor = { starting: 'yellow', running: 'green', error: 'red', stopped: 'gray' }[status];

  // Visible lines for display
  const visibleLines = lines.slice(effectiveOffset, effectiveOffset + displayHeight);

  // Dynamic help text
  const helpText =
    mode === 'select-agent'
      ? '↑↓ select · Enter confirm · q quit'
      : mode === 'input'
        ? 'Enter send · Esc cancel'
        : status === 'starting'
          ? `${supportedAgents.length > 1 ? 'Esc back' : 'Esc quit'}`
          : isStreaming
            ? '↑↓ scroll'
            : conversation.length > 0
              ? `↑↓ scroll · Enter invoke · C clear · Ctrl+R restart · ${supportedAgents.length > 1 ? 'Esc back' : 'Esc quit'}`
              : `Enter to send a message · Ctrl+R restart · ${supportedAgents.length > 1 ? 'Esc back' : 'Esc quit'}`;

  // Agent selection screen
  if (mode === 'select-agent') {
    const agentItems = supportedAgents.map((agent, i) => ({
      id: String(i),
      title: agent.name,
      description: `${agent.runtimeVersion} · ${agent.build}`,
    }));

    return (
      <Screen title="Dev Server" onExit={handleExit} helpText={helpText}>
        <Panel title="Select Agent" fullWidth>
          <SelectList items={agentItems} selectedIndex={selectedAgentIndex} />
        </Panel>
      </Screen>
    );
  }

  const headerContent = (
    <Box flexDirection="column">
      <Box>
        <Text>Agent: </Text>
        <Text color="green">{config?.agentName}</Text>
      </Box>
      {modelProvider && (
        <Box>
          <Text>Provider: </Text>
          <Text color="green">{modelProvider}</Text>
        </Box>
      )}
      <Box>
        <Text>Server: </Text>
        <Text color="cyan">http://localhost:{actualPort}/invocations</Text>
      </Box>
      {!isExiting && (
        <Box>
          <Text>Status: </Text>
          {status === 'starting' ? (
            <Text color="yellow">{config?.buildType === 'Container' ? 'Starting container...' : 'Starting...'}</Text>
          ) : (
            <Text color={statusColor}>{status}</Text>
          )}
        </Box>
      )}
      {(conversation.length === 0 || status === 'error') &&
        logs
          .filter(l => l.level === 'error')
          .slice(-10)
          .map((l, i) => (
            <Text key={i} color="red">
              {l.message}
            </Text>
          ))}
      {isExiting && (
        <Box>
          <Text color="yellow">Stopping server...</Text>
        </Box>
      )}
      {logFilePath && <LogLink filePath={logFilePath} />}
      {hasMemory && (
        <Text color="yellow">
          AgentCore memory is not available when running locally. To test memory, deploy and use invoke.
        </Text>
      )}
    </Box>
  );

  return (
    <Screen title="Dev Server" onExit={handleExit} helpText={helpText} headerContent={headerContent}>
      <Box flexDirection="column" flexGrow={1}>
        {/* Conversation display - always visible when there's content */}
        {(conversation.length > 0 || isStreaming) && (
          <Box flexDirection="column" height={needsScroll ? displayHeight : undefined}>
            {visibleLines.map((line, idx) => (
              <Text key={effectiveOffset + idx} color={line.color} wrap="truncate">
                {line.text || ' '}
              </Text>
            ))}
            {/* Thinking indicator - shows while waiting for response to start */}
            {isStreaming && !streamingResponse && <GradientText text="Thinking..." />}
          </Box>
        )}

        {/* Scroll indicator */}
        {needsScroll && (
          <Text dimColor>
            [{effectiveOffset + 1}-{Math.min(effectiveOffset + displayHeight, totalLines)} of {totalLines}]
          </Text>
        )}

        {/* Input line - always visible at bottom */}
        {/* Unfocused: dim arrow, press Enter to focus */}
        {/* Focused: blue arrow with cursor, type and press Enter to send */}
        {status === 'running' && mode === 'chat' && !isStreaming && (
          <Box>
            <Text dimColor>&gt; </Text>
          </Box>
        )}
        {status === 'running' && mode === 'input' && (
          <Box>
            <Text color="blue">&gt; </Text>
            <TextInput
              prompt=""
              hideArrow
              onSubmit={text => {
                if (text.trim()) {
                  void handleInvoke(text);
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
