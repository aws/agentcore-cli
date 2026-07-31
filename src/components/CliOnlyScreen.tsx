import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { Layout } from "./Layout";
import { darkTheme } from "./ui/_core.js";
import type { ScreenProps } from "../handlers/types";

export interface CliOnlyScreenProps extends ScreenProps {
  breadcrumb: string[];
  // command is the CLI invocation shown to the user
  // operation, e.g. "agentcore identity api-key-credential-provider create --help".
  command: string;
}

// CliOnlyScreen is the supported TUI experience for operations that are
// intentionally CLI-only
export function CliOnlyScreen({ breadcrumb, command }: CliOnlyScreenProps) {
  const navigate = useNavigate();

  useInput((_input, key) => {
    if (key.escape) navigate(-1);
  });

  return (
    <Layout
      breadcrumb={breadcrumb}
      keyHints={[
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={darkTheme.colors.text}>This operation is available via the CLI:</Text>
        <Box paddingTop={1}>
          <Text color={darkTheme.colors.focus}>{command}</Text>
        </Box>
      </Box>
    </Layout>
  );
}
