import { useStdout } from 'ink';
import React, { type ReactNode, createContext, useContext } from 'react';

const DEFAULT_WIDTH = 80;

interface LayoutContextValue {
  contentWidth: number;
}

const LayoutContext = createContext<LayoutContextValue>({
  contentWidth: DEFAULT_WIDTH,
});

// eslint-disable-next-line react-refresh/only-export-components
export function useLayout(): LayoutContextValue {
  return useContext(LayoutContext);
}

interface LayoutProviderProps {
  children: ReactNode;
}

export function LayoutProvider({ children }: LayoutProviderProps) {
  const { stdout } = useStdout();
  const contentWidth = stdout?.columns ?? DEFAULT_WIDTH;

  return <LayoutContext.Provider value={{ contentWidth }}>{children}</LayoutContext.Provider>;
}
