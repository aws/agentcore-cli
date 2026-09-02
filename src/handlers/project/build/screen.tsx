import { useNavigate } from "react-router";
import { useApp } from "ink";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { ProjectKey } from "../../../router";
import type { ScreenProps } from "../../types";
import { ProjectGate } from "../ProjectGate";
import type { Project } from "../types";
import { builtMessage } from "./index";

const BREADCRUMB = ["agentcore", "project", "build"];
const DESCRIPTION = "build the project's deployable artifacts";

// BuildProjectScreen is `agentcore project build` from the menu. It runs the
// same projectManager.build generator the command runs, and ConfirmAction
// renders its steps through the same TaskList runWithProgress renders on the
// command line — the TUI is a frame around the CLI's own progress, not a
// second progress UI.
export function BuildProjectScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <BuildConfirm project={project} core={core} />}
    </ProjectGate>
  );
}

function BuildConfirm({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const { exit } = useApp();

  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      title={project.name}
      rows={[
        { label: "root", value: project.rootPath },
        { label: "agents", value: String(project.spec.runtimes.length) },
      ]}
      message={`Build project '${project.name}'?`}
      isPending={false}
      error={null}
      action={async function* () {
        yield* core.projectManager.build(project);
        return [{ label: "result", value: builtMessage(project) }];
      }}
      successTitle={builtMessage(project)}
      runningLabel="building…"
      onDone={() => exit()}
      onCancel={() => navigate("/agentcore/project")}
    />
  );
}
