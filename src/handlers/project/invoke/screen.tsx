import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { DeploymentTargetPicker } from "../../../components/DeploymentTargetPicker";
import { Layout } from "../../../components/Layout";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { Spinner } from "../../../components/ui/spinner";
import { glyphs } from "../../../components/ui/_core.js";
import { ProjectKey, type Context } from "../../../router";
import { HarnessChat } from "../../harness/invoke/screen";
import { AwsCredentialProviderKey } from "../../keys";
import { RuntimeInvokeConsole } from "../../runtime/invoke/screen";
import type { ScreenProps } from "../../types";
import type { Project, ResolvedDeployedResources } from "../types";
import { ProjectGate } from "../ProjectGate";

type ProjectInvokableRow = Record<string, unknown> & {
  resourceType: "runtime" | "harness";
  type: "Runtime" | "Harness";
  name: string;
  id: string;
  protocol: string;
  source: string;
};

const columns = [
  { key: "type", header: "type", width: 10 },
  { key: "name", header: "name", flex: true },
  { key: "protocol", header: "protocol", width: 10 },
  { key: "source", header: "source", width: 24 },
] satisfies DataTableColumn<ProjectInvokableRow>[];

type Destination =
  | { resourceType: "runtime"; id: string; ctx: Context; qualifier?: string }
  | { resourceType: "harness"; id: string; ctx: Context };

const BREADCRUMB = ["agentcore", "project", "invoke"];
const DESCRIPTION = "invoke a Runtime or harness from the current project";
const PROJECT_MENU = "/agentcore/project";

// The project comes from the launch context when a project command opened the
// TUI, and is resolved from the cwd otherwise — the gate reports the CLI's own
// not-found guidance when there is none, rather than spinning forever.
export function ProjectInvokePickerScreen({ ctx, core }: ScreenProps) {
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
          {({ targetName, back }) => (
            <ProjectInvokePicker
              ctx={ctx}
              core={core}
              project={project}
              targetName={targetName}
              onBack={back}
            />
          )}
        </DeploymentTargetPicker>
      )}
    </ProjectGate>
  );
}

function ProjectInvokePicker({
  ctx,
  core,
  project,
  targetName,
  onBack,
}: ScreenProps & {
  project: Project;
  targetName: string;
  onBack: () => void;
}) {
  const [deployed, setDeployed] = useState<ResolvedDeployedResources>();
  const [destination, setDestination] = useState<Destination>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void core.projectManager
      .resolveDeployedResources(project, { target: targetName })
      .then((resolved) => {
        if (active) setDeployed(resolved);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [core.projectManager, project, targetName]);

  const rows = useMemo<ProjectInvokableRow[]>(
    () =>
      (deployed?.resources ?? []).map((resource) => {
        if (resource.resourceType === "runtime") {
          const configured = project.spec.runtimes.find(({ name }) => name === resource.name);
          return {
            ...resource,
            type: "Runtime" as const,
            protocol: configured?.protocol ?? "HTTP",
            source: configured?.codeLocation ?? "-",
          };
        }
        const configured = project.spec.harnesses.find(({ name }) => name === resource.name);
        return {
          ...resource,
          type: "Harness" as const,
          protocol: "-",
          source: configured?.path ?? "-",
        };
      }),
    [deployed, project],
  );

  const select = (row: ProjectInvokableRow) => {
    setDestination({
      resourceType: row.resourceType,
      id: row.id,
      ctx: ctx.withValue(AwsCredentialProviderKey, row.credentialProvider),
    });
  };

  useInput((_input, key) => {
    if (key.escape && (!deployed || error !== undefined)) onBack();
  });

  if (destination?.resourceType === "runtime") {
    if (!destination.qualifier) {
      return (
        <RuntimeEndpointPicker
          ctx={destination.ctx}
          core={core}
          runtimeId={destination.id}
          breadcrumb={["agentcore", "runtime", "invoke", destination.id]}
          description="choose an endpoint to invoke"
          onSelect={(qualifier) => setDestination({ ...destination, qualifier })}
          onEscape={() => setDestination(undefined)}
        />
      );
    }
    return (
      <RuntimeInvokeConsole
        ctx={destination.ctx}
        core={core}
        runtimeId={destination.id}
        qualifier={destination.qualifier}
        onBack={() => setDestination(undefined)}
      />
    );
  }

  if (destination?.resourceType === "harness") {
    return (
      <HarnessChat
        ctx={destination.ctx}
        core={core}
        harnessId={destination.id}
        variant="invoke"
        onBack={() => setDestination(undefined)}
      />
    );
  }

  if (error !== undefined) {
    return (
      <Layout
        breadcrumb={BREADCRUMB}
        description="unable to load deployed resources"
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        <Text color="red">
          {glyphs.cross} {error}
        </Text>
      </Layout>
    );
  }

  if (!deployed) {
    return (
      <Layout
        breadcrumb={BREADCRUMB}
        description="resolving deployed resources"
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        <Spinner label="resolving deployed resources…" />
      </Layout>
    );
  }

  return (
    <Layout
      breadcrumb={BREADCRUMB}
      description={`choose a project resource to invoke on target ${targetName}`}
      keyHints={[
        { key: "↑↓/jk", label: "navigate" },
        { key: "/", label: "filter" },
        { key: "enter", label: "select" },
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column">
        <DataTable
          borderStyle="none"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          showFooter={false}
          focus
          columns={columns}
          data={rows}
          emptyMessage={`No deployed Runtimes or harnesses were found on target ${targetName}.`}
          onSelect={select}
          onEscape={onBack}
        />
      </Box>
    </Layout>
  );
}
