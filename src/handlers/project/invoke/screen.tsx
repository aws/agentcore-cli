import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { Layout } from "../../../components/Layout";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { Spinner } from "../../../components/ui/spinner";
import { ProjectKey, type Context } from "../../../router";
import { HarnessChat } from "../../harness/invoke/screen";
import { RegionKey } from "../../keys";
import { RuntimeInvokeConsole } from "../../runtime/invoke/screen";
import type { ScreenProps } from "../../types";
import type { Project, ResolvedDeployedResources } from "../types";

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

export function ProjectInvokePickerScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | undefined>(() => ctx.value(ProjectKey));
  const [deployed, setDeployed] = useState<ResolvedDeployedResources>();
  const [destination, setDestination] = useState<Destination>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (project) return;
    let active = true;
    const from = process.cwd();
    void core.projectManager
      .resolve({ filePath: from })
      .then((resolved) => {
        if (!active) return;
        if (!resolved) {
          setError(
            `No AgentCore project found at ${from} or any parent directory ` +
              `(looked for agentcore/agentcore.json). ` +
              `Run 'agentcore project create' to scaffold one.`,
          );
          return;
        }
        setProject(resolved);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [core.projectManager, project]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    void core.projectManager
      .resolveDeployedResources(project, { target: "default" })
      .then((resolved) => {
        if (active) setDeployed(resolved);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [core.projectManager, project]);

  const rows = useMemo<ProjectInvokableRow[]>(
    () =>
      // resolveDeployedResources now returns every deployed resource type, but only
      // runtimes and harnesses are invokable — drop the rest so they aren't listed.
      (deployed?.resources ?? [])
        .filter(
          (r): r is typeof r & { resourceType: "runtime" | "harness" } =>
            r.resourceType === "runtime" || r.resourceType === "harness",
        )
        .map((resource) => {
          if (resource.resourceType === "runtime") {
            const configured = project?.spec.runtimes.find(({ name }) => name === resource.name);
            return {
              ...resource,
              type: "Runtime" as const,
              protocol: configured?.protocol ?? "HTTP",
              source: configured?.codeLocation ?? "-",
            };
          }
          const configured = project?.spec.harnesses.find(({ name }) => name === resource.name);
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
    if (!deployed) return;
    setDestination({
      resourceType: row.resourceType,
      id: row.id,
      ctx: ctx.withValue(RegionKey, deployed.target.region),
    });
  };

  const goBack = () => navigate("/agentcore/project");
  useInput((_input, key) => {
    if (key.escape && (!project || !deployed || error !== undefined)) goBack();
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

  if (!project || (!deployed && !error)) {
    return (
      <Layout
        breadcrumb={["agentcore", "project", "invoke"]}
        description={project ? "resolving deployed resources" : "resolving the current project"}
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]}
      >
        <Spinner label={project ? "Resolving deployed resources…" : "Resolving project…"} />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout
        breadcrumb={["agentcore", "project", "invoke"]}
        description="unable to load deployed resources"
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]}
      >
        <Text color="red">{error}</Text>
      </Layout>
    );
  }

  return (
    <Layout
      breadcrumb={["agentcore", "project", "invoke"]}
      description="choose a project resource to invoke on target default"
      keyHints={[
        { key: "↑↓/jk", label: "navigate" },
        { key: "/", label: "filter" },
        { key: "enter", label: "select" },
        { key: "esc", label: "cancel" },
        { key: "ctl+c", label: "quit" },
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
          emptyMessage="No deployed Runtimes or Harnesses were found on target default."
          onSelect={select}
          onEscape={goBack}
        />
      </Box>
    </Layout>
  );
}
