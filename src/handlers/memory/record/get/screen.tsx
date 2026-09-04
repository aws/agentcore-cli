import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function MemoryRecordGetScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { memoryId, recordId } = useParams();
  const detail = useQuery({
    queryKey: ["memory-record", opts.region, memoryId, recordId],
    queryFn: () =>
      core.memory.getMemoryRecord(
        {
          memoryId: memoryId!,
          memoryRecordId: recordId!,
        },
        opts,
      ),
    enabled: memoryId !== undefined && recordId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "memory", "record", "get", memoryId ?? "", recordId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.memoryRecord}
      loadingLabel={`loading Memory record ${recordId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}
