import type { ScreenProps } from "../../types";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { useRegionNavigate } from "../../utils";

// HarnessListScreen lists the caller's harnesses in a table; selecting one pushes
// to HarnessGetScreen with the harness ID as a path value.
export function HarnessListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();

  return (
    <HarnessPicker
      {...props}
      breadcrumb={["agentcore", "harness", "list"]}
      description="list harnesses"
      onSelect={(harnessId) => navigate(`/agentcore/harness/get/${harnessId}`)}
    />
  );
}
