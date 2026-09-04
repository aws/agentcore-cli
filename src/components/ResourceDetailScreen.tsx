import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { KeyValueTable } from "./KeyValueTable.js";
import { Layout } from "./Layout";
import { darkTheme, glyphs } from "./ui/_core.js";
import { Divider } from "./ui/divider/Divider.js";
import { Spinner } from "./ui/spinner";

export interface ResourceDetailAction {
  name: string;
  description: string;
  onSelect: () => void;
}

export interface ResourceDetailScreenProps {
  breadcrumb: string[];
  isPending: boolean;
  error: Error | null;
  items: Record<string, string>;
  actions: ResourceDetailAction[];
  loadingLabel: string;
  onRetry?: () => void;
  selectLabel?: string;
}

export function ResourceDetailScreen({
  breadcrumb,
  isPending,
  error,
  items,
  actions,
  loadingLabel,
  onRetry,
  selectLabel = "select",
}: ResourceDetailScreenProps) {
  const navigate = useNavigate();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ready = !isPending && !error;

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }
    if (input === "r" && error && onRetry) {
      onRetry();
      return;
    }
    if (!ready || actions.length === 0) return;
    if (key.upArrow || input === "k") {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((current) => Math.min(actions.length - 1, current + 1));
      return;
    }
    if (key.return) actions[selectedIndex]?.onSelect();
  });

  const nameWidth = actions.reduce((width, action) => Math.max(width, action.name.length), 0) + 3;

  return (
    <Layout
      breadcrumb={breadcrumb}
      keyHints={[
        ...(ready && actions.length > 1 ? [{ key: "↑↓/jk", label: "navigate" }] : []),
        ...(ready && actions.length > 0 ? [{ key: "enter", label: selectLabel }] : []),
        ...(error && onRetry ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      {isPending ? (
        <Spinner label={loadingLabel} />
      ) : error ? (
        <Text color="red">Error: {error.message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" paddingLeft={1}>
            <KeyValueTable items={items} />
          </Box>

          {actions.length > 0 && (
            <>
              <Divider />

              <Box flexDirection="column" paddingLeft={1}>
                {actions.map((action, actionIndex) => {
                  const selected = actionIndex === selectedIndex;
                  return (
                    <Box key={action.name}>
                      <Text color={darkTheme.colors.focus}>
                        {selected ? `${glyphs.pointer} ` : "  "}
                      </Text>
                      <Text
                        bold={selected}
                        color={selected ? darkTheme.colors.focus : darkTheme.colors.text}
                      >
                        {action.name.padEnd(nameWidth)}
                      </Text>
                      <Text color={darkTheme.colors.muted}>{action.description}</Text>
                    </Box>
                  );
                })}
              </Box>
            </>
          )}
        </Box>
      )}
    </Layout>
  );
}
