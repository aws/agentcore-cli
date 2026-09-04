import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { HarnessPicker } from "../../../../components/HarnessPicker";
import { EndpointWizard } from "../../../../components/EndpointWizard";
import { useFinishFlow } from "../../../../components/useFinishFlow";
import { useRegionNavigate } from "../../../utils";

// HarnessCreateEndpointScreen is the interactive endpoint create flow. Without
// a `:harnessId` route value it renders a harness picker; with one it runs the
// endpoint wizard (name → version → review) ending in a
// CreateHarnessEndpoint call. Success lands on the endpoint's detail.
export function HarnessCreateEndpointScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const finishFlow = useFinishFlow("/agentcore/harness/endpoint");
  const { harnessId } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "endpoint", "create"]}
        description="choose a harness to create an endpoint for"
        onSelect={(id) => navigate(`/agentcore/harness/endpoint/create/${id}`)}
      />
    );
  }

  return (
    <EndpointWizard
      {...props}
      mode="create"
      harnessId={harnessId}
      breadcrumb={["agentcore", "harness", "endpoint", "create", harnessId]}
      onDone={(endpointName) =>
        finishFlow(`/agentcore/harness/endpoint/get/${harnessId}/${endpointName}`)
      }
    />
  );
}
