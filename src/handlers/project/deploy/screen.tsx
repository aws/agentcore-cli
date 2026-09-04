import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { Layout } from "../../../components/Layout";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { DEFAULT_TARGET_NAME, type AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectKey, type Context } from "../../../router";
import { RegionKey } from "../../keys";
import type { ScreenProps } from "../../types";
import { LoadingFrame, ProjectGate } from "../ProjectGate";
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
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(PROJECT_MENU)}
    >
      {(project) => <DeployTarget project={project} ctx={ctx} core={core} />}
    </ProjectGate>
  );
}

type TargetRow = Record<string, unknown> & AwsDeploymentTarget;

const TARGET_COLUMNS = [
  { key: "name", header: "target", width: 16 },
  { key: "account", header: "account", width: 14 },
  { key: "region", header: "region", flex: true },
] satisfies DataTableColumn<TargetRow>[];

function DeployTarget({
  project,
  ctx,
  core,
}: {
  project: Project;
  ctx: Context;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string>();

  // A fresh project has no aws-targets.json yet: the list is empty and deploy
  // provisions `default` on first run.
  const targets = useQuery({
    queryKey: ["project-targets", project.rootPath],
    queryFn: () => core.projectManager.listTargets(project),
    gcTime: 0,
  });

  if (targets.data === undefined || targets.isFetching || targets.isError) {
    return (
      <LoadingFrame
        breadcrumb={BREADCRUMB}
        description={DESCRIPTION}
        query={targets}
        loadingLabel="reading deployment targets…"
        onBack={() => navigate(PROJECT_MENU)}
      />
    );
  }

  const declared = targets.data;
  const targetName =
    chosen ?? (declared.length <= 1 ? (declared[0]?.name ?? DEFAULT_TARGET_NAME) : undefined);

  if (targetName === undefined) {
    return (
      <Layout
        breadcrumb={BREADCRUMB}
        description="choose a deployment target"
        keyHints={[
          { key: "↑↓", label: "navigate" },
          { key: "enter", label: "select" },
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]}
      >
        <DataTable
          borderStyle="none"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          showFooter={false}
          focus
          columns={TARGET_COLUMNS}
          data={declared as TargetRow[]}
          emptyMessage="No deployment targets are configured."
          onSelect={(row) => setChosen(row.name)}
          onEscape={() => navigate(PROJECT_MENU)}
        />
      </Layout>
    );
  }

  return (
    <DeployConfirm
      project={project}
      ctx={ctx}
      core={core}
      targetName={targetName}
      target={declared.find((candidate) => candidate.name === targetName)}
      // With a choice behind us, esc returns to it; otherwise to the menu.
      onCancel={() => (declared.length > 1 ? setChosen(undefined) : navigate(PROJECT_MENU))}
    />
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
        const result = yield* core.projectManager.deploy(project, {
          target: targetName,
          region,
          confirmTeardown: async () => teardown,
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
