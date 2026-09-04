import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { Layout } from "../../../components/Layout";
import { TreeView } from "../../../components/ui/tree-view";
import {
  linkedResourceLabel,
  typeColumnWidth,
  type LinkedResourceNode,
} from "../../../components/LinkedResources";
import { serviceIdFromArn } from "../../../core/arn";
import { darkTheme } from "../../../components/ui/_core.js";
import { ProjectKey } from "../../../router";
import type { ScreenProps } from "../../types";
import type { DeployableResource, Project, ResolvedProjectResource } from "../types";
import { LoadingFrame, ProjectGate } from "../ProjectGate";

const theme = darkTheme;

const BREADCRUMB = ["agentcore", "project", "status"];
const PROJECT_MENU = "/agentcore/project";
// The TUI opens only from a bare invocation (an explicit --target keeps the
// headless report), so the screen always shows the default target, like the
// invoke picker.
const TARGET_NAME = "default";

// The detail routes a deployed resource can forward to. Types without a detail
// screen are listed but not navigable.
const DETAIL_ROUTES: Partial<Record<DeployableResource, (id: string) => string>> = {
  runtime: (id) => `/agentcore/runtime/get/${encodeURIComponent(id)}`,
  harness: (id) => `/agentcore/harness/get/${encodeURIComponent(id)}`,
  memory: (id) => `/agentcore/memory/get/${encodeURIComponent(id)}`,
  gateway: (id) => `/agentcore/gateway/get/${encodeURIComponent(id)}`,
};

// resolveProjectResources reports most ids as ARNs (e.g.
// arn:aws:bedrock-agentcore:<region>:<account>:memory/<memoryId>) while the
// detail routes and Core clients take the bare service id — see
// serviceIdFromArn, which passes non-ARN ids (a gateway target's, for one)
// through unchanged.
type StatusNode = LinkedResourceNode;

// routeFor resolves the detail route for a deployed resource. Gateway targets
// have a detail screen too, but its route needs the owning gateway's id, which
// only the parent row carries.
function routeFor(
  resource: ResolvedProjectResource,
  parent?: ResolvedProjectResource,
): string | undefined {
  if (resource.deploymentState !== "deployed") return undefined;
  if (resource.resourceType === "gateway-target") {
    if (parent?.deploymentState !== "deployed") return undefined;
    const gatewayId = encodeURIComponent(serviceIdFromArn(parent.id));
    return `/agentcore/gateway/target/get/${gatewayId}/${encodeURIComponent(resource.id)}`;
  }
  return DETAIL_ROUTES[resource.resourceType]?.(serviceIdFromArn(resource.id));
}

// buildStatusNodes groups the resolved resources by agent. Each entry in
// spec.runtimes (code agents) and spec.harnesses (managed harness agents) is a
// top-level group holding the agent's own deployed resource; everything not
// attributable to an agent lands in a shared "project" group so nothing the
// project declares is dropped.
//
// Memories group under runtime agents: the CDK L3 injects a MEMORY_<NAME>_ID
// env var for every declared memory into every runtime (see
// src/core/project/templates/runtime.ts), so each declared memory is reachable
// from each runtime agent. A harness's memory binding lives in its own
// harness.json (HarnessMemoryRefSchema), not in the project spec this report is
// built from — a managed one is provisioned inside the harness and never
// appears here — so harness groups list just the harness itself and memories a
// harness may reference by name stay visible under the project group.
export function buildStatusNodes(
  spec: Project["spec"],
  resources: ResolvedProjectResource[],
): StatusNode[] {
  const byKey = new Map(resources.map((r) => [`${r.resourceType}:${r.name}`, r]));
  const claimed = new Set<string>();
  const claim = (resourceType: DeployableResource, name: string) => {
    const resource = byKey.get(`${resourceType}:${name}`);
    if (resource) claimed.add(`${resourceType}:${name}`);
    return resource;
  };

  // The type column is sized for the resource rows (depth 1); rows nested
  // deeper give up the width their guide characters take.
  const typeWidth = typeColumnWidth(resources.map((r) => r.resourceType));

  const resourceNode = (
    resource: ResolvedProjectResource,
    parentId: string,
    depth: number,
    parent?: ResolvedProjectResource,
  ): StatusNode => {
    const id = `${parentId}/${resource.resourceType}:${resource.name}`;
    const type = resource.resourceType;
    const route = routeFor(resource, parent);
    const deployed = resource.deploymentState === "deployed";
    return {
      id,
      label: linkedResourceLabel(type, resource.name, typeWidth, depth - 1),
      annotation: deployed ? "deployed" : "local-only",
      // A declared-but-undeployed resource has nothing to fetch, so its row
      // cannot be selected; deployed types without a detail screen stay
      // selectable and explain themselves instead.
      disabled: !deployed,
      defaultExpanded: true,
      children: resource.children?.map((child) => resourceNode(child, id, depth + 1, resource)),
      data: route ? { route } : { hint: `${type} ${resource.name} has no detail view.` },
    };
  };

  const agentGroups: StatusNode[] = [
    ...spec.runtimes.map(({ name }): StatusNode => {
      const id = `agent:${name}`;
      const children = [
        claim("runtime", name),
        ...spec.memories.map(({ name: memoryName }) => claim("memory", memoryName)),
      ].filter((resource) => resource !== undefined);
      return {
        id,
        label: name,
        annotation: "agent",
        defaultExpanded: true,
        children: children.map((resource) => resourceNode(resource, id, 1)),
      };
    }),
    ...spec.harnesses.map(({ name }): StatusNode => {
      const id = `agent:${name}`;
      const children = [claim("harness", name)].filter((resource) => resource !== undefined);
      return {
        id,
        label: name,
        annotation: "agent",
        defaultExpanded: true,
        children: children.map((resource) => resourceNode(resource, id, 1)),
      };
    }),
  ];

  const shared = resources.filter((r) => !claimed.has(`${r.resourceType}:${r.name}`));
  const sharedGroup: StatusNode[] = shared.length
    ? [
        {
          id: "project",
          label: "project",
          annotation: "shared resources",
          defaultExpanded: true,
          children: shared.map((resource) => resourceNode(resource, "project", 1)),
        },
      ]
    : [];

  return [...agentGroups, ...sharedGroup];
}

// The project comes from the launch context when a project command opened the
// TUI, and is resolved from the cwd otherwise — the gate reports the CLI's own
// not-found guidance when there is none.
export function ProjectStatusScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description="the project's linked resources on target default"
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(PROJECT_MENU)}
    >
      {(project) => <ProjectStatusView core={core} project={project} />}
    </ProjectGate>
  );
}

function ProjectStatusView({
  core,
  project,
}: Pick<ScreenProps, "core"> & {
  project: Project;
}) {
  const navigate = useNavigate();
  const [hint, setHint] = useState<string>();

  const status = useQuery({
    queryKey: ["project-status", project.rootPath, TARGET_NAME],
    queryFn: () => core.projectManager.resolveProjectResources(project, { target: TARGET_NAME }),
  });

  const nodes = useMemo(
    () => (status.data ? buildStatusNodes(project.spec, status.data.resources) : []),
    [project, status.data],
  );

  const goBack = () => navigate(PROJECT_MENU);
  // Only once the tree is up — while loading or on an error the LoadingFrame
  // below owns escape (and retry).
  useInput((_input, key) => {
    if (key.escape && status.data !== undefined) goBack();
  });

  if (!status.data) {
    return (
      <LoadingFrame
        breadcrumb={BREADCRUMB}
        description="the project's linked resources on target default"
        query={status}
        loadingLabel="Resolving project resources…"
        onBack={goBack}
      />
    );
  }

  const select = (node: StatusNode) => {
    if (node.data?.route) {
      // The detail screens fetch in their context's region, which is the
      // ambient one — link with ?region= so the destination fetches where the
      // project actually deployed (see useCoreOpts). Escape there is a history
      // pop back here.
      const region = encodeURIComponent(status.data.target.region);
      navigate(`${node.data.route}?region=${region}`);
      return;
    }
    setHint(node.data?.hint);
  };

  return (
    <Layout
      breadcrumb={BREADCRUMB}
      description={`the project's linked resources on target ${status.data.target.name}`}
      keyHints={[
        { key: "↑↓/jk", label: "navigate" },
        { key: "←→", label: "collapse/expand" },
        { key: "enter", label: "open" },
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column" paddingX={1}>
        <Text bold>resources</Text>
        <Box flexDirection="column">
          {nodes.length === 0 ? (
            <Text color={theme.colors.muted}>
              No resources are declared in this project. Run `agentcore project add` to declare one.
            </Text>
          ) : (
            <TreeView nodes={nodes} onSelect={select} showIcons={false} focusMarker />
          )}
        </Box>
        {hint !== undefined && (
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>{hint}</Text>
          </Box>
        )}
      </Box>
    </Layout>
  );
}
