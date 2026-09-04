import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { HarnessPicker } from "../../../../components/HarnessPicker";
import { HarnessEndpointPicker } from "../../../../components/HarnessEndpointPicker";
import { useRegionNavigate } from "../../../utils";

// HarnessListEndpointsScreen lists a harness's endpoints. Without a `:harnessId`
// route value it renders a harness picker first; with one it lists that
// harness's endpoints, and selecting an endpoint opens its JSON detail.
export function HarnessListEndpointsScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { harnessId } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "endpoint", "list"]}
        description="choose a harness to list endpoints for"
        onSelect={(id) => navigate(`/agentcore/harness/endpoint/list/${id}`)}
      />
    );
  }

  return (
    <HarnessEndpointPicker
      {...props}
      harnessId={harnessId}
      breadcrumb={["agentcore", "harness", "endpoint", "list", harnessId]}
      onSelect={(endpointName) =>
        navigate(`/agentcore/harness/endpoint/get/${harnessId}/${endpointName}`)
      }
    />
  );
}
