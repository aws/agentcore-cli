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

function useMemoryDetail({ ctx, core }: ScreenProps, memoryId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["memory", opts.region, memoryId, "full"],
    queryFn: () => core.memory.getMemory(memoryId!, "full", opts),
    enabled: memoryId !== undefined,
  });
}

export function MemoryGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { memoryId } = useParams();
  const detail = useMemoryDetail(props, memoryId);
  const memory = detail.data?.memory;

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }
    if (input === "r" && detail.isError) {
      void detail.refetch();
      return;
    }
    if (detail.isError || !memory) return;
    if (key.return && memoryId) {
      navigate(`/agentcore/memory/get/${encodeURIComponent(memoryId)}/json`);
    }
  });

  return (
    <Layout
      breadcrumb={["agentcore", "memory", "get", memoryId ?? ""]}
      keyHints={[
        ...(!detail.isPending && !detail.isError ? [{ key: "enter", label: "open detail" }] : []),
        ...(detail.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      {detail.isPending ? (
        <Spinner label="Loading Memory…" />
      ) : detail.isError ? (
        <Text color="red">Error: {(detail.error as Error).message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" paddingLeft={1}>
            <KeyValueTable
              items={{
                name: memory?.name ?? "",
                id: memory?.id ?? "",
                status: memory?.status ?? "",
                eventExpiryDays: memory?.eventExpiryDuration?.toString() ?? "-",
                strategies: memory?.strategies?.length.toString() ?? "0",
                updatedAt: memory?.updatedAt?.toISOString() ?? "-",
                ...(memory?.failureReason ? { failureReason: memory.failureReason } : {}),
                arn: memory?.arn ?? "",
              }}
            />
          </Box>

          <Divider />

          <Box paddingLeft={1}>
            <Text color={darkTheme.colors.focus}>❯ </Text>
            <Text bold color={darkTheme.colors.focus}>
              {"detail".padEnd(9)}
            </Text>
            <Text color={darkTheme.colors.muted}>show the full JSON definition</Text>
          </Box>
        </Box>
      )}
    </Layout>
  );
}

export function MemoryGetJsonScreen(props: ScreenProps) {
  const { memoryId } = useParams();
  const detail = useMemoryDetail(props, memoryId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "memory", "get", memoryId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.memory}
      loadingLabel="Loading Memory…"
      onRetry={() => void detail.refetch()}
    />
  );
}
