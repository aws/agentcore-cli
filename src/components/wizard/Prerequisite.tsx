import { Box, Text, useInput } from "ink";
import { Layout } from "../Layout";
import { darkTheme } from "../ui/_core.js";

const theme = darkTheme;

export interface PrerequisiteProps {
  breadcrumb: string[];
  description?: string;
  // message says what the project lacks, e.g. "this project has no Gateways yet".
  message: string;
  // command is the CLI command that would add it, shown as the way forward.
  command: string;
  // onBack runs on esc; the screen the user came from.
  onBack: () => void;
}

// Prerequisite stands in for a wizard whose first question has no possible
// answer — a Policy needs a Policy Engine, a connector needs a Gateway. It
// names what is missing and how to add it, instead of offering an empty picker.
export function Prerequisite({
  breadcrumb,
  description,
  message,
  command,
  onBack,
}: PrerequisiteProps) {
  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={[
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.colors.warning}>{message}</Text>
        <Text color={theme.colors.muted}>add one first with `{command}`</Text>
      </Box>
    </Layout>
  );
}
