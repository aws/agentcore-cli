import { useNavigate } from "react-router";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { DeploymentTargetPicker } from "../../../components/DeploymentTargetPicker";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { GlobalConfigAccessorKey, ProjectKey, type Context } from "../../../router";
import { RegionKey } from "../../keys";
import type { ScreenProps } from "../../types";
import { ProjectGate } from "../ProjectGate";
import type { Project } from "../types";
import { declaresNothingDeployable, deployedMessage, teardownQuestion } from "./index";

const BREADCRUMB = ["agentcore", "project", "deploy"];
const DESCRIPTION = "deploy the project to AWS";
const PROJECT_MENU = "/agentcore/project";

// DeployProjectScreen runs the same projectManager.deploy generator the command
// runs; ConfirmAction renders its steps through the same TaskList. With several
// targets it asks which first — the TUI's stand-in for --target.
export function DeployProjectScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const goBack = () => navigate(PROJECT_MENU);
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={goBack}
    >
      {(project) => (
        <DeploymentTargetPicker
          core={core}
          project={project}
          breadcrumb={BREADCRUMB}
          description={DESCRIPTION}
          onBack={goBack}
        >
          {({ targetName, target, back }) => (
            <DeployConfirm
              project={project}
              ctx={ctx}
              core={core}
              targetName={targetName}
              target={target}
              onCancel={back}
            />
          )}
        </DeploymentTargetPicker>
      )}
    </ProjectGate>
  );
}

function DeployConfirm({
  project,
  ctx,
  core,
  targetName,
  target,
  onCancel,
}: {
  project: Project;
  ctx: Context;
  core: ScreenProps["core"];
  targetName: string;
  target: AwsDeploymentTarget | undefined;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const region = ctx.require(RegionKey);

  // Confirmed only when the deploy would tear the stack down, the one case the
  // command asks. Nothing may block on input once the progress UI is up, so the
  // answer is the pre-answered decision the backend consults; if its own count
  // disagrees with this preflight it reports the "re-run with --yes" error.
  const teardown = target !== undefined && declaresNothingDeployable(project);

  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      rows={{ project: project.name, target: targetName }}
      trigger={
        teardown
          ? { kind: "confirm", message: teardownQuestion(project.name, target) }
          : { kind: "immediate" }
      }
      isPending={false}
      error={null}
      action={async function* () {
        const globalConfig = await ctx.value(GlobalConfigAccessorKey)?.get();
        const result = yield* core.projectManager.deploy(project, {
          target: targetName,
          region,
          confirmTeardown: async () => teardown,
          transactionSearch: globalConfig?.transactionSearch,
        });
        // The title follows the result, not the preflight heuristic, which
        // synthesis can disagree with. Outputs are not listed: the command
        // prints them only with --json.
        return { title: deployedMessage(project, targetName, result), rows: {} };
      }}
      successTitle="Deploy finished"
      runningLabel="deploying…"
      onDone={() => navigate(PROJECT_MENU)}
      doneLabel="go back"
      onCancel={onCancel}
    />
  );
}
