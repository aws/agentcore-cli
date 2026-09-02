import { Box, Text, useInput } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export function ErrorPanel({ message, onBack }: { message: string; onBack: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onBack();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.error}>✗ {message}</Text>
      <Text color={theme.colors.muted}>{"  esc returns to the form"}</Text>
    </Box>
  );
}
