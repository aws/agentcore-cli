import type { LogEntry } from './LogPanel';
import { Box, Text, useInput, useStdout } from 'ink';
import { useMemo, useState } from 'react';

const LOG_COLORS: Record<LogEntry['level'], string | undefined> = {
  error: 'red',
  warn: 'yellow',
  system: 'cyan',
  info: 'gray',
  response: 'green',
};

interface FullScreenLogViewProps {
  logs: LogEntry[];
  logFilePath?: string;
  onExit: () => void;
}

/**
 * Full-screen log viewer with smooth cursor-style scrolling.
 * Press Esc or q to exit back to normal view.
 */
export function FullScreenLogView({ logs, logFilePath, onExit }: FullScreenLogViewProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  // Reserve lines for header (3) and footer (2)
  const viewportHeight = Math.max(5, terminalHeight - 5);

  const maxScrollPos = Math.max(0, logs.length - viewportHeight);

  // Track user scroll offset from bottom (0 = at bottom, positive = scrolled up)
  const [scrollUpOffset, setScrollUpOffset] = useState(0);

  // Compute effective cursor position - clamp offset to valid range and convert to position
  const cursorPos = useMemo(() => {
    const effectiveOffset = Math.min(scrollUpOffset, maxScrollPos);
    return Math.max(0, maxScrollPos - effectiveOffset);
  }, [scrollUpOffset, maxScrollPos]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'q') || input === 'l') {
      onExit();
      return;
    }

    // Smooth scrolling (offset from bottom, so up arrow increases offset)
    if (key.upArrow || input === 'k') {
      setScrollUpOffset(offset => Math.min(maxScrollPos, offset + 1));
    }
    if (key.downArrow || input === 'j') {
      setScrollUpOffset(offset => Math.max(0, offset - 1));
    }

    // Page scrolling
    if (key.pageUp) {
      setScrollUpOffset(offset => Math.min(maxScrollPos, offset + viewportHeight));
    }
    if (key.pageDown) {
      setScrollUpOffset(offset => Math.max(0, offset - viewportHeight));
    }

    // Home/End (g = top = max offset, G = bottom = 0 offset)
    if (input === 'g') {
      setScrollUpOffset(maxScrollPos);
    }
    if (input === 'G') {
      setScrollUpOffset(0);
    }
  });

  const visibleLogs = logs.slice(cursorPos, cursorPos + viewportHeight);
  const scrollPercent = logs.length <= viewportHeight ? 100 : Math.round((cursorPos / maxScrollPos) * 100);

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header */}
      <Box borderStyle="single" borderBottom borderColor="gray" paddingX={1}>
        <Box flexGrow={1}>
          <Text bold color="cyan">
            📋 Log Viewer
          </Text>
          <Text dimColor> ({logs.length} entries)</Text>
        </Box>
        {logFilePath && <Text dimColor>File: {logFilePath}</Text>}
      </Box>

      {/* Log content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleLogs.length === 0 ? (
          <Text dimColor>No logs yet</Text>
        ) : (
          visibleLogs.map((log, idx) => (
            <Box key={cursorPos + idx} flexDirection={log.level === 'response' ? 'column' : 'row'}>
              {log.level === 'response' ? (
                <Box flexDirection="column">
                  <Text color="green" bold>
                    ─── Response ───
                  </Text>
                  <Text wrap="wrap">{log.message}</Text>
                </Box>
              ) : (
                <>
                  <Text dimColor>{String(cursorPos + idx + 1).padStart(4)} </Text>
                  {log.level !== 'system' && (
                    <Text color={LOG_COLORS[log.level]}>{log.level.toUpperCase().padEnd(6)} </Text>
                  )}
                  {log.level === 'system' && <Text>{''.padEnd(7)}</Text>}
                  <Text color={LOG_COLORS[log.level]} wrap="wrap">
                    {log.message}
                  </Text>
                </>
              )}
            </Box>
          ))
        )}
      </Box>

      {/* Scrollbar indicator */}
      <Box justifyContent="flex-end" paddingX={1}>
        <Text dimColor>
          {cursorPos > 0 ? '↑' : ' '} {scrollPercent}% {cursorPos < maxScrollPos ? '↓' : ' '}
        </Text>
      </Box>

      {/* Footer */}
      <Box borderStyle="single" borderTop borderColor="gray" paddingX={1}>
        <Text dimColor>↑/k up · ↓/j down · PgUp/PgDn page · g/G top/bottom · Esc/q/l exit</Text>
      </Box>
    </Box>
  );
}
