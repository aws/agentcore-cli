import { useNavigate } from "react-router";
import type { ScreenProps } from "../../types";
import { HarnessWizard } from "../../../components/HarnessWizard";
import { useFinishFlow } from "../../../components/useFinishFlow";

const MENU_PATH = "/agentcore/harness";

// HarnessCreateScreen is the interactive create-harness flow: a step wizard
// (name → model provider → memory → tools → prompt → review) that ends in a
// CreateHarness call. Success lands on the new harness's hub, with esc from
// there returning to the harness menu rather than the finished wizard.
export function HarnessCreateScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const finishFlow = useFinishFlow(MENU_PATH);

  return (
    <HarnessWizard
      {...props}
      mode="create"
      breadcrumb={["agentcore", "harness", "create"]}
      description="create a harness"
      onDone={(harnessId) => finishFlow(`/agentcore/harness/get/${harnessId}`)}
      onExit={() => navigate(MENU_PATH)}
    />
  );
}
