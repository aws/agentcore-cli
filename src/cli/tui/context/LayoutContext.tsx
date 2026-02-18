import { useStdout } from 'ink';
import React, { type ReactNode, createContext, useContext } from 'react';

/** Maximum content width cap */
const MAX_CONTENT_WIDTH = 60;

interface LayoutContextValue {
  /** Global content width: min(terminalWidth, MAX_CONTENT_WIDTH) */
  contentWidth: number;
}

const LayoutContext = createContext<LayoutContextValue>({
  contentWidth: MAX_CONTENT_WIDTH,
});

// eslint-disable-next-line react-refresh/only-export-components
export function useLayout(): LayoutContextValue {
  return useContext(LayoutContext);
}

/**
 * Build the logo dynamically based on width.
 * The logo has fixed text "  >_ AgentCore" on left and version on right,
 * with padding in between to fill the width.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildLogo(width: number, version?: string): string {
  const left = '│  >_ AgentCore';
  const right = version ? `v${version} │` : '│';
  // -2 for the border chars already in left/right
  const innerWidth = width - 2;
  const paddingNeeded = innerWidth - (left.length - 1) - (right.length - 1);
  const padding = ' '.repeat(Math.max(0, paddingNeeded));

  const topBorder = '┌' + '─'.repeat(innerWidth) + '┐';
  const bottomBorder = '└' + '─'.repeat(innerWidth) + '┘';
  const middle = left + padding + right;

  return `\n${topBorder}\n${middle}\n${bottomBorder}`;
}

interface LayoutProviderProps {
  children: ReactNode;
}

export function LayoutProvider({ children }: LayoutProviderProps) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? MAX_CONTENT_WIDTH;
  const contentWidth = Math.min(terminalWidth, MAX_CONTENT_WIDTH);

  return <LayoutContext.Provider value={{ contentWidth }}>{children}</LayoutContext.Provider>;
}
