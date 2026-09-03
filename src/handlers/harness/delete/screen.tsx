import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { ConfirmAction } from "../../../components/ConfirmAction";

// HarnessDeleteScreen deletes a harness. Without a `:harnessId` route value it
// renders a harness picker; with one it shows the harness summary and asks for
// confirmation before calling DeleteHarness.
export function HarnessDeleteScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { harnessId } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "delete"]}
        description="choose a harness to delete"
        onSelect={(id) => navigate(`/agentcore/harness/delete/${id}`)}
      />
    );
  }
  return <DeleteConfirm {...props} harnessId={harnessId} />;
}

function DeleteConfirm({ ctx, core, harnessId }: ScreenProps & { harnessId: string }) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId, opts),
  });
  const harness = detail.data?.harness;

  return (
    <ConfirmAction
      breadcrumb={["agentcore", "harness", "delete", harnessId]}
      title={harness?.harnessName ?? harnessId}
      rows={[
        { label: "arn", value: harness?.arn ?? "-" },
        { label: "status", value: harness?.status ?? "-" },
        { label: "version", value: harness?.harnessVersion ?? "-" },
      ]}
      trigger={{
        kind: "confirm",
        message: `Delete harness ${harness?.harnessName ?? harnessId}? This permanently removes the harness, its versions, and its endpoints.`,
      }}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      action={async () => {
        const response = await core.harness.deleteHarness({ harnessId }, opts);
        return [
          { label: "id", value: response.harness?.harnessId ?? harnessId },
          { label: "status", value: response.harness?.status ?? "DELETING" },
        ];
      }}
      successTitle="Harness deletion started"
      runningLabel="Deleting harness…"
      onDone={() => navigate("/agentcore/harness/list")}
    />
  );
}
