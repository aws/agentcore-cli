/**
 * Reusable bordered panel component.
 */
import { useLayout } from '../context';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface PanelProps {
  title?: string;
  children: ReactNode;
  borderColor?: string;
  height?: number;
  flexGrow?: number;
  flexBasis?: number | string;
  /** If true, panel fills available width instead of using contentWidth */
  fullWidth?: boolean;
}

export function Panel({ title, children, borderColor, height, flexGrow, flexBasis, fullWidth = true }: PanelProps) {
  const { contentWidth } = useLayout();

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      height={height}
      flexGrow={flexGrow}
      flexBasis={flexBasis}
      width={fullWidth ? '100%' : contentWidth}
    >
      {title && (
        <Text bold dimColor>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
}
