import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../components/JsonDetail";
import { KeyValueTable } from "../../../components/KeyValueTable.js";
import { Layout } from "../../../components/Layout";
import { darkTheme } from "../../../components/ui/_core.js";
import { Divider } from "../../../components/ui/divider/Divider.js";
import { Spinner } from "../../../components/ui/spinner";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { withoutSdkMetadata } from "../withoutSdkMetadata";

const ACTIONS = [
  {
    name: "detail",
    description: "show the full JSON definition",
    to: (id: string) => `/agentcore/runtime/get/${encodeURIComponent(id)}/json`,
  },
  {
    name: "versions",
    description: "list immutable Runtime versions",
    to: (id: string) => `/agentcore/runtime/version/list/${encodeURIComponent(id)}`,
  },
  {
    name: "endpoints",
    description: "list this Runtime's endpoints",
    to: (id: string) => `/agentcore/runtime/endpoint/list/${encodeURIComponent(id)}`,
  },
] as const;

export function RuntimeGetScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const { runtimeId } = useParams();
  const [index, setIndex] = useState(0);
  const detail = useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: () => core.runtime.getRuntime(runtimeId!, opts),
    enabled: runtimeId !== undefined,
  });

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }
    if (input === "r" && detail.isError) {
      void detail.refetch();
      return;
    }
    if (detail.isError || !detail.data) return;
    if (key.upArrow || input === "k") {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((current) => Math.min(ACTIONS.length - 1, current + 1));
      return;
    }
    if (key.return && runtimeId) navigate(ACTIONS[index]!.to(runtimeId));
  });

  const nameWidth = ACTIONS.reduce((width, action) => Math.max(width, action.name.length), 0) + 3;

  return (
    <Layout
      breadcrumb={["agentcore", "runtime", "get", runtimeId ?? ""]}
      keyHints={[
        ...(!detail.isPending && !detail.isError
          ? [
              { key: "↑↓/jk", label: "navigate" },
              { key: "enter", label: "select" },
            ]
          : []),
        ...(detail.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      {detail.isPending ? (
        <Spinner label="Loading Runtime…" />
      ) : detail.isError ? (
        <Text color="red">Error: {(detail.error as Error).message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" paddingLeft={1}>
            <KeyValueTable
              items={{
                id: detail.data.agentRuntimeId ?? "",
                status: detail.data.status ?? "",
                ...(detail.data.failureReason ? { failureReason: detail.data.failureReason } : {}),
                version: detail.data.agentRuntimeVersion ?? "",
                protocol: detail.data.protocolConfiguration?.serverProtocol ?? "-",
                network: detail.data.networkConfiguration?.networkMode ?? "-",
                arn: detail.data.agentRuntimeArn ?? "",
              }}
            />
          </Box>

          <Divider />

          <Box flexDirection="column" paddingLeft={1}>
            {ACTIONS.map((action, actionIndex) => {
              const selected = actionIndex === index;
              return (
                <Box key={action.name}>
                  <Text color={darkTheme.colors.focus}>{selected ? "❯ " : "  "}</Text>
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
        </Box>
      )}
    </Layout>
  );
}

export function RuntimeGetJsonScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { runtimeId } = useParams();
  const detail = useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: () => core.runtime.getRuntime(runtimeId!, opts),
    enabled: runtimeId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "runtime", "get", runtimeId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={withoutSdkMetadata(detail.data)}
      loadingLabel="Loading Runtime…"
      onRetry={() => void detail.refetch()}
    />
  );
}
