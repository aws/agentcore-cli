import { Box, Text } from "ink";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export function EventLog({ events }: { events: string[] }) {
  return (
    <Box flexDirection="column">
      {events.map((message, index) => (
        <Text key={`${index}-${message}`} color={theme.colors.muted}>
          ✓ {message}
        </Text>
      ))}
    </Box>
  );
}
