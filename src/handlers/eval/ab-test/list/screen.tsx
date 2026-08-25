import { useNavigate } from "react-router";
import { AbTestPicker } from "../../../../components/AbTestPicker";
import type { ScreenProps } from "../../../types";

export function AbTestListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <AbTestPicker
      {...props}
      breadcrumb={["agentcore", "eval", "ab-test", "list"]}
      onSelect={(abTestId) =>
        navigate(`/agentcore/eval/ab-test/get/${encodeURIComponent(abTestId)}`)
      }
    />
  );
}
