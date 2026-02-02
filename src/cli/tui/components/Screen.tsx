import { HELP_TEXT } from '../constants';
import { useExitHandler } from '../hooks';
import { ScreenHeader } from './ScreenHeader';
import { ScreenLayout } from './ScreenLayout';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

interface ScreenProps {
  title: string;
  color?: string;
  onExit: () => void;
  helpText?: string;
  headerContent?: ReactNode;
  /** Optional content to display above the help text at the bottom */
  footerContent?: ReactNode;
  children: ReactNode;
}

/**
 * Standard screen wrapper that provides:
 * - ScreenLayout with responsive padding
 * - ScreenHeader with title
 * - Exit handling (Escape / Ctrl+Q)
 * - Help text at the bottom
 */
export function Screen({ title, color, onExit, helpText, headerContent, footerContent, children }: ScreenProps) {
  useExitHandler(onExit);

  const displayHelpText = helpText ?? HELP_TEXT.EXIT;

  return (
    <ScreenLayout>
      <ScreenHeader title={title} color={color}>
        {headerContent}
      </ScreenHeader>
      {children}
      {footerContent && <Box marginTop={1}>{footerContent}</Box>}
      <Box marginTop={footerContent ? 0 : 1}>
        <Text dimColor>{displayHelpText}</Text>
      </Box>
    </ScreenLayout>
  );
}
