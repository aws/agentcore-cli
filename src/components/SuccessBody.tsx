import { Box, Text, useInput } from "ink";
import { KeyValueTable } from "./KeyValueTable";
import { darkTheme, glyphs } from "./ui/_core.js";

const theme = darkTheme;

export interface SuccessBodyProps {
  title: string;
  rows?: Record<string, string>;
  nextSteps?: string[];
  hint?: string;
  onDone: () => void;
  doneLabel?: string;
}

export function SuccessBody({
  title,
  rows = {},
  nextSteps,
  hint,
  onDone,
  doneLabel = "continue",
}: SuccessBodyProps) {
  useInput((_input, key) => {
    if (key.return || key.escape) onDone();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        {glyphs.check} {title}
      </Text>
      {Object.keys(rows).length > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <KeyValueTable items={rows} />
        </Box>
      )}
      {nextSteps !== undefined && nextSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.text}>next steps</Text>
          {nextSteps.map((step) => (
            <Text key={step} color={theme.colors.primary}>{`  ${step}`}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          {hint ?? (
            <>
              press <Text color={theme.colors.focus}>enter</Text> to {doneLabel}
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}
