import { Box, Text } from 'ink';

interface HelpTextProps {
  text: string;
}

/**
 * Standard help text component shown at the bottom of screens.
 * Displays dimmed text with consistent styling.
 */
export function HelpText({ text }: HelpTextProps) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

/**
 * Standard exit help text.
 */
export function ExitHelpText() {
  return <HelpText text="Press ESC or Ctrl+Q to exit" />;
}
