import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { LoadingFrame } from "../handlers/project/ProjectGate";
import type { Project } from "../handlers/project/types";
import type { Core } from "../handlers/types";
import { usePinRegion } from "../handlers/utils";
import { DEFAULT_TARGET_NAME, type AwsDeploymentTarget } from "../projectSchemas/aws-targets";
import { Layout } from "./Layout";
import { DataTable, type DataTableColumn } from "./ui/data-table";

type TargetRow = Record<string, unknown> & AwsDeploymentTarget;

const TARGET_COLUMNS = [
  { key: "name", header: "target", width: 16 },
  { key: "account", header: "account", width: 14 },
  { key: "region", header: "region", flex: true },
] satisfies DataTableColumn<TargetRow>[];

export interface ChosenDeploymentTarget {
  targetName: string;
  // target is unset for a project that declares no targets yet: the name is
  // then DEFAULT_TARGET_NAME, which deploy provisions on first run.
  target: AwsDeploymentTarget | undefined;
  // back returns to the picker when there was a choice, else to onBack.
  back: () => void;
}

export interface DeploymentTargetPickerProps {
  core: Core;
  project: Project;
  breadcrumb: string[];
  description: string;
  onBack: () => void;
  // children must return an element rather than call hooks, as with ProjectGate.
  children: (chosen: ChosenDeploymentTarget) => React.ReactElement;
}

// DeploymentTargetPicker is the TUI's stand-in for --target. Zero or one
// declared target resolves without asking, several ask which. The choice lives
// in the route's query string so a detail page opened from the screen returns
// to the chosen target rather than to the question. The chosen target's region
// is pinned so the screen and what it opens fetch where the target deployed.
export function DeploymentTargetPicker({
  core,
  project,
  breadcrumb,
  description,
  onBack,
  children,
}: DeploymentTargetPickerProps) {
  const [search, setSearch] = useSearchParams();
  const chosen = search.get("target") ?? undefined;

  const targets = useQuery({
    queryKey: ["project-targets", project.rootPath],
    queryFn: () => core.projectManager.listTargets(project),
    gcTime: 0,
  });

  const declared = targets.data ?? [];
  const targetName =
    chosen ?? (declared.length <= 1 ? (declared[0]?.name ?? DEFAULT_TARGET_NAME) : undefined);
  const target = declared.find((candidate) => candidate.name === targetName);
  usePinRegion(target?.region);

  if (targets.data === undefined || targets.isFetching || targets.isError) {
    return (
      <LoadingFrame
        breadcrumb={breadcrumb}
        description={description}
        query={targets}
        loadingLabel="reading deployment targets…"
        onBack={onBack}
      />
    );
  }

  if (targetName === undefined) {
    return (
      <Layout
        breadcrumb={breadcrumb}
        description="choose a deployment target"
        keyHints={[
          { key: "↑↓", label: "navigate" },
          { key: "enter", label: "select" },
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
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
          onSelect={(row) => setSearch({ target: row.name }, { replace: true })}
          onEscape={onBack}
        />
      </Layout>
    );
  }

  return children({
    targetName,
    target,
    back: declared.length > 1 ? () => setSearch({}, { replace: true }) : onBack,
  });
}
