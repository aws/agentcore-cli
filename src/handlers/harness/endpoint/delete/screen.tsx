import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { HarnessPicker } from "../../../../components/HarnessPicker";
import { HarnessEndpointPicker } from "../../../../components/HarnessEndpointPicker";
import { ConfirmAction } from "../../../../components/ConfirmAction";
import { useFinishFlow } from "../../../../components/useFinishFlow";

// HarnessDeleteEndpointScreen deletes a harness endpoint. It walks the user
// from a harness picker to an endpoint picker to a confirmation, then calls
// DeleteHarnessEndpoint.
export function HarnessDeleteEndpointScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { harnessId, endpointName } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "endpoint", "delete"]}
        description="choose the harness the endpoint belongs to"
        onSelect={(id) => navigate(`/agentcore/harness/endpoint/delete/${id}`)}
      />
    );
  }
  if (!endpointName) {
    return (
      <HarnessEndpointPicker
        {...props}
        harnessId={harnessId}
        breadcrumb={["agentcore", "harness", "endpoint", "delete", harnessId]}
        description="choose an endpoint to delete"
        onSelect={(name) => navigate(`/agentcore/harness/endpoint/delete/${harnessId}/${name}`)}
      />
    );
  }
  return <DeleteConfirm {...props} harnessId={harnessId} endpointName={endpointName} />;
}

function DeleteConfirm({
  ctx,
  core,
  harnessId,
  endpointName,
}: ScreenProps & { harnessId: string; endpointName: string }) {
  const opts = coreOptsFromCtx(ctx);
  const finishFlow = useFinishFlow("/agentcore/harness/endpoint");

  const detail = useQuery({
    queryKey: ["harness-endpoint", opts.region, harnessId, endpointName],
    queryFn: () => core.harness.getHarnessEndpoint(harnessId, endpointName, opts),
  });
  const endpoint = detail.data?.endpoint;

  return (
    <ConfirmAction
      breadcrumb={["agentcore", "harness", "endpoint", "delete", harnessId, endpointName]}
      title={endpoint?.endpointName ?? endpointName}
      rows={[
        { label: "arn", value: endpoint?.arn ?? "-" },
        { label: "status", value: endpoint?.status ?? "-" },
        { label: "target", value: endpoint?.targetVersion ?? "-" },
      ]}
      trigger={{
        kind: "confirm",
        message: `Delete endpoint ${endpointName}? Callers using it will lose access.`,
      }}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      action={async () => {
        const response = await core.harness.deleteHarnessEndpoint(
          { harnessId, endpointName },
          opts,
        );
        return [
          { label: "name", value: response.endpoint?.endpointName ?? endpointName },
          { label: "status", value: response.endpoint?.status ?? "DELETING" },
        ];
      }}
      successTitle="Endpoint deletion started"
      runningLabel="Deleting endpoint…"
      onDone={() => finishFlow(`/agentcore/harness/endpoint/list/${harnessId}`)}
    />
  );
}
