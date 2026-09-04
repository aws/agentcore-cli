import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { HarnessPicker } from "../../../../components/HarnessPicker";
import { HarnessVersionPicker } from "../../../../components/HarnessVersionPicker";
import { useRegionNavigate } from "../../../utils";

// HarnessListVersionsScreen lists a harness's versions. Without a `:harnessId`
// route value it renders a harness picker first; with one it lists that
// harness's versions, and selecting a version opens its JSON detail.
export function HarnessListVersionsScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { harnessId } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "version", "list"]}
        description="choose a harness to list versions for"
        onSelect={(id) => navigate(`/agentcore/harness/version/list/${id}`)}
      />
    );
  }

  return (
    <HarnessVersionPicker
      {...props}
      harnessId={harnessId}
      breadcrumb={["agentcore", "harness", "version", "list", harnessId]}
      onSelect={(version) => navigate(`/agentcore/harness/version/get/${harnessId}/${version}`)}
    />
  );
}
