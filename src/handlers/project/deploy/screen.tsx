import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { Layout } from "../../../components/Layout";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { Spinner } from "../../../components/ui/spinner";
import { DEFAULT_TARGET_NAME, type AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
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
// command line. With one target (or none yet) it deploys there; with several,
// it asks which — the TUI's stand-in for --target.
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

  // The declared targets decide whether there is anything to choose. A fresh
  // project has no aws-targets.json yet: the list is empty, and deploy
  // provisions `default` on first run, as the command does.
  const targets = useQuery({
    queryKey: ["project-targets", project.rootPath],
    queryFn: () => core.projectManager.listTargets(project),
  });

  if (targets.isPending || targets.isError) {
    return (
      <Layout
        breadcrumb={BREADCRUMB}
        description={DESCRIPTION}
        keyHints={[{ key: "ctl+c", label: "quit" }]}
      >
        <Box paddingX={1}>
          {targets.isError ? (
            <Text color="red">{(targets.error as Error).message}</Text>
          ) : (
            <Spinner label="reading deployment targets…" />
          )}
        </Box>
      </Layout>
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

  // A deploy is confirmed only when it would tear the stack down — the same
  // rule as the command, which asks its readline question in exactly that case
  // and otherwise just deploys. Once the progress UI is up nothing may block on
  // input, so the answer here is the pre-answered decision the backend
  // consults; when the backend's own count disagrees with this preflight, it
  // reports the "re-run with --yes" error as it does for a non-interactive run.
  const teardown = target !== undefined && declaresNothingDeployable(project);

  return (
    <ConfirmAction
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      rows={[
        { label: "project", value: project.name },
        { label: "target", value: targetName },
      ]}
      message={teardown ? teardownQuestion(project.name, target) : undefined}
      isPending={false}
      error={null}
      action={async function* () {
        const result = yield* core.projectManager.deploy(project, {
          target: targetName,
          region,
          confirmTeardown: async () => teardown,
        });
        // The outcome comes from the result, as the command's own line does:
        // the preflight heuristic above only decides what to ask, and the
        // backend's post-synth count can disagree with it. Stack outputs are
        // not listed — the command prints them only with --json.
        return { title: deployedMessage(project, targetName, result), rows: [] };
      }}
      successTitle="Deploy finished"
      runningLabel="deploying…"
      onDone={() => navigate(PROJECT_MENU)}
      doneLabel="go back"
      onCancel={onCancel}
    />
  );
}
