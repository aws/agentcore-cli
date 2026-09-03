import { useNavigate } from "react-router";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { ProjectKey } from "../../../router";
import type { ScreenProps } from "../../types";
import { ProjectGate } from "../ProjectGate";
import type { Project } from "../types";
import { builtMessage } from "./index";

const BREADCRUMB = ["agentcore", "project", "build"];
const DESCRIPTION = "build the project's deployable artifacts";
const PROJECT_MENU = "/agentcore/project";

// BuildProjectScreen runs the same projectManager.build generator the command
// runs; ConfirmAction renders its steps through the same TaskList.
export function BuildProjectScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(PROJECT_MENU)}
    >
      {(project) => <BuildConfirm project={project} core={core} />}
    </ProjectGate>
  );
}

function BuildConfirm({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();

  // No confirmation: a build changes nothing outside the project directory.
  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      isPending={false}
      error={null}
      action={async function* () {
        yield* core.projectManager.build(project);
        return [];
      }}
      successTitle={builtMessage(project)}
      runningLabel="building…"
      nextSteps={["agentcore project deploy"]}
      onDone={() => navigate(PROJECT_MENU)}
      doneLabel="go back"
      onCancel={() => navigate(PROJECT_MENU)}
    />
  );
}
