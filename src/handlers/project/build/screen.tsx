import { useNavigate } from "react-router";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { ProjectKey } from "../../../router";
import { RegionKey } from "../../keys";
import type { ScreenProps } from "../../types";
import { ProjectGate } from "../ProjectGate";
import type { Project } from "../types";
import { builtMessage } from "./index";

const BREADCRUMB = ["agentcore", "build"];
const DESCRIPTION = "build the project's deployable artifacts";
const PROJECT_MENU = "/agentcore";

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
      {(project) => <BuildConfirm project={project} core={core} region={ctx.value(RegionKey)} />}
    </ProjectGate>
  );
}

function BuildConfirm({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  /** The region withRegion resolved, as the build command passes it. */
  region: string | undefined;
}) {
  const navigate = useNavigate();

  // No confirmation: a build changes nothing outside the project directory.
  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      trigger={{ kind: "immediate" }}
      isPending={false}
      error={null}
      action={async function* () {
        yield* core.projectManager.build(project, { region });
        return { rows: {} };
      }}
      successTitle={builtMessage(project)}
      runningLabel="building…"
      nextSteps={["agentcore deploy"]}
      onDone={() => navigate(PROJECT_MENU)}
      doneLabel="go back"
      onCancel={() => navigate(PROJECT_MENU)}
    />
  );
}
