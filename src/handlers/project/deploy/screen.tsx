import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useApp } from "ink";
import { ConfirmAction, type SummaryRow } from "../../../components/ConfirmAction";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { ProjectKey, type Context } from "../../../router";
import { RegionKey } from "../../keys";
import type { ScreenProps } from "../../types";
import { ProjectGate } from "../ProjectGate";
import type { Project } from "../types";
import { declaresNothingDeployable, deployedMessage, teardownQuestion } from "./index";

const BREADCRUMB = ["agentcore", "project", "deploy"];
const DESCRIPTION = "deploy the project to AWS";
const PROJECT_MENU = "/agentcore/project";

// DeployProjectScreen is `agentcore project deploy` from the menu. It runs the
// same projectManager.deploy generator the command runs, and ConfirmAction
// renders its steps through the same TaskList runWithProgress renders on the
// command line. The teardown question the command asks over readline is asked
// here as the confirmation itself.
export function DeployProjectScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(PROJECT_MENU)}
    >
      {(project) => <DeployConfirm project={project} ctx={ctx} core={core} />}
    </ProjectGate>
  );
}

function DeployConfirm({
  project,
  ctx,
  core,
}: {
  project: Project;
  ctx: Context;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const { exit } = useApp();
  const region = ctx.require(RegionKey);
  const targetName = DEFAULT_TARGET_NAME;

  // The target is resolved up front, as the command does, because the teardown
  // question is only asked when there is a target whose stack could be removed.
  const target = useQuery({
    queryKey: ["project-target", project.rootPath, targetName],
    queryFn: () => core.projectManager.resolveTarget(project, { target: targetName }),
  });

  // Once the progress UI is up nothing may block on input, so the teardown
  // decision is settled by the confirmation the user is about to answer: when
  // the project declares nothing deployable, confirming *is* confirming the
  // teardown. Otherwise the backend's own zero-resource check reports the
  // "re-run with --yes" error, as it does for a non-interactive deploy.
  const teardown = target.data !== undefined && declaresNothingDeployable(project);
  const message = teardown
    ? teardownQuestion(project.name, target.data!)
    : `Deploy project '${project.name}' to target '${targetName}'?`;

  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      title={project.name}
      rows={[
        { label: "target", value: targetName },
        {
          label: "account",
          value: target.data
            ? `${target.data.account}/${target.data.region}`
            : `created on first deploy (${region})`,
        },
      ]}
      message={message}
      isPending={target.isPending}
      error={target.isError ? (target.error as Error) : null}
      action={async function* () {
        const result = yield* core.projectManager.deploy(project, {
          target: targetName,
          region,
          confirmTeardown: async () => teardown,
        });
        // The outcome comes from the result, as the command's own line does:
        // the preflight heuristic above only decides what to ask, and the
        // backend's post-synth count can disagree with it.
        const rows: SummaryRow[] = Object.entries(result.outputs).map(([label, value]) => ({
          label,
          value,
        }));
        return { title: deployedMessage(project, targetName, result), rows };
      }}
      successTitle="Deploy finished"
      runningLabel="deploying…"
      onDone={() => exit()}
      onCancel={() => navigate(PROJECT_MENU)}
    />
  );
}
