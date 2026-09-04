import { Text } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { useCoreOpts, useRegionNavigate } from "../../../utils";
import { HarnessPicker } from "../../../../components/HarnessPicker";
import { HarnessEndpointPicker } from "../../../../components/HarnessEndpointPicker";
import { EndpointWizard } from "../../../../components/EndpointWizard";
import { Layout } from "../../../../components/Layout";
import { Spinner } from "../../../../components/ui/spinner";
import { useFinishFlow } from "../../../../components/useFinishFlow";

// HarnessUpdateEndpointScreen is the interactive endpoint update flow: pick the
// harness, pick the endpoint, then run the endpoint wizard prefilled with the
// endpoint's current target version, ending in an UpdateHarnessEndpoint call.
export function HarnessUpdateEndpointScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { harnessId, endpointName } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "endpoint", "update"]}
        description="choose the harness the endpoint belongs to"
        onSelect={(id) => navigate(`/agentcore/harness/endpoint/update/${id}`)}
      />
    );
  }
  if (!endpointName) {
    return (
      <HarnessEndpointPicker
        {...props}
        harnessId={harnessId}
        breadcrumb={["agentcore", "harness", "endpoint", "update", harnessId]}
        description="choose an endpoint to update"
        onSelect={(name) => navigate(`/agentcore/harness/endpoint/update/${harnessId}/${name}`)}
      />
    );
  }
  return <UpdateWizard {...props} harnessId={harnessId} endpointName={endpointName} />;
}

function UpdateWizard({
  ctx,
  core,
  harnessId,
  endpointName,
}: ScreenProps & { harnessId: string; endpointName: string }) {
  const opts = useCoreOpts(ctx);
  const finishFlow = useFinishFlow("/agentcore/harness/endpoint");

  // The wizard seeds its form state once on mount, so it renders only after the
  // endpoint's current settings have arrived.
  const detail = useQuery({
    queryKey: ["harness-endpoint", opts.region, harnessId, endpointName],
    queryFn: () => core.harness.getHarnessEndpoint(harnessId, endpointName, opts),
  });

  if (detail.isPending || detail.isError) {
    return (
      <Layout
        breadcrumb={["agentcore", "harness", "endpoint", "update", harnessId, endpointName]}
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        {detail.isPending ? (
          <Spinner label="loading endpoint…" />
        ) : (
          <Text color="red">Error: {(detail.error as Error).message}</Text>
        )}
      </Layout>
    );
  }

  const endpoint = detail.data.endpoint;
  return (
    <EndpointWizard
      ctx={ctx}
      core={core}
      mode="update"
      harnessId={harnessId}
      endpointName={endpointName}
      breadcrumb={["agentcore", "harness", "endpoint", "update", harnessId, endpointName]}
      initial={{
        name: endpointName,
        // A settled endpoint reports only liveVersion (targetVersion clears
        // once the transition finishes), so fall back to what's serving.
        version: endpoint?.targetVersion ?? endpoint?.liveVersion ?? "",
      }}
      onDone={(name) => finishFlow(`/agentcore/harness/endpoint/get/${harnessId}/${name}`)}
    />
  );
}
