import { Box, Text, useInput } from "ink";
import { darkTheme, glyphs } from "./ui/_core.js";

const theme = darkTheme;

export function ErrorPanel({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onRetry?: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || key.return) onBack();
    if (input === "r" && onRetry) onRetry();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.error}>
        {glyphs.cross} {message}
      </Text>
      <Text color={theme.colors.muted}>{"  esc returns to the form"}</Text>
    </Box>
  );
}
