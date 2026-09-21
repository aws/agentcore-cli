import { useQueryClient } from "@tanstack/react-query";
import { Text, useInput } from "ink";
import { useRef, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";
import { Layout } from "../../../components/Layout";
import { ConfirmAction, type SummaryRows } from "../../../components/ConfirmAction";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { ProjectKey } from "../../../router";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { Project, RemoveResourceInput } from "../types";
import type { ScreenProps } from "../../types";
import { ProjectGate, projectQueryKey } from "../ProjectGate";
import { APP_CODE_RETAINED_NOTICE, shouldShowAppCodeNotice } from "./notice";

type RootResourceType =
  | "runtime"
  | "harness"
  | "memory"
  | "credential"
  | "config-bundle"
  | "evaluator"
  | "gateway"
  | "policy-engine"
  | "payment-manager";

type RemovableResourceType =
  | RootResourceType
  | "online-eval"
  | "online-insight"
  | "gateway-target"
  | "gateway-connector"
  | "policy"
  | "payment-connector"
  | "runtime-endpoint";

type RemovableResource = RemoveResourceInput & { parentName?: string };

type RemovableResourcePickerConfig = {
  resourceType: RemovableResourceType;
  parentColumnLabel?: string;
  listResources: (spec: ProjectSpec) => RemovableResource[];
};

function rootResourceTypePickerConfig(
  resourceType: RootResourceType,
  listFromSpec: (spec: ProjectSpec) => { name: string }[],
): RemovableResourcePickerConfig {
  return {
    resourceType,
    listResources: (spec) => listFromSpec(spec).map(({ name }) => ({ resourceType, name })),
  };
}

const RESOURCE_PICKER_CONFIGS: RemovableResourcePickerConfig[] = [
  rootResourceTypePickerConfig("runtime", (spec) => spec.runtimes),
  rootResourceTypePickerConfig("harness", (spec) => spec.harnesses),
  rootResourceTypePickerConfig("memory", (spec) => spec.memories),
  rootResourceTypePickerConfig("credential", (spec) => spec.credentials),
  rootResourceTypePickerConfig("config-bundle", (spec) => spec.configBundles),
  rootResourceTypePickerConfig("evaluator", (spec) => spec.evaluators),
  // online-eval and online-insight share the onlineEvalConfigs collection; an
  // insight config is the one with a non-empty `insights` array.
  {
    resourceType: "online-eval",
    listResources: (spec) =>
      spec.onlineEvalConfigs
        .filter((config) => (config.insights?.length ?? 0) === 0)
        .map(({ name }) => ({ resourceType: "online-eval", name })),
  },
  {
    resourceType: "online-insight",
    listResources: (spec) =>
      spec.onlineEvalConfigs
        .filter((config) => (config.insights?.length ?? 0) > 0)
        .map(({ name }) => ({ resourceType: "online-insight", name })),
  },
  rootResourceTypePickerConfig("gateway", (spec) => spec.agentCoreGateways),
  rootResourceTypePickerConfig("policy-engine", (spec) => spec.policyEngines),
  rootResourceTypePickerConfig("payment-manager", (spec) => spec.payments ?? []),
  {
    resourceType: "gateway-target",
    parentColumnLabel: "gateway",
    listResources: (spec) =>
      spec.agentCoreGateways.flatMap((gateway) =>
        gateway.targets
          .filter((target) => target.targetType !== "connector")
          .map((target) => ({
            resourceType: "gateway-target",
            gatewayName: gateway.name,
            name: target.name,
            parentName: gateway.name,
          })),
      ),
  },
  {
    resourceType: "gateway-connector",
    parentColumnLabel: "gateway",
    listResources: (spec) =>
      spec.agentCoreGateways.flatMap((gateway) =>
        gateway.targets
          .filter((target) => target.targetType === "connector")
          .map((target) => ({
            resourceType: "gateway-target",
            gatewayName: gateway.name,
            name: target.name,
            parentName: gateway.name,
          })),
      ),
  },
  {
    resourceType: "policy",
    parentColumnLabel: "policy engine",
    listResources: (spec) =>
      spec.policyEngines.flatMap((engine) =>
        engine.policies.map((policy) => ({
          resourceType: "policy",
          engineName: engine.name,
          name: policy.name,
          parentName: engine.name,
        })),
      ),
  },
  {
    resourceType: "payment-connector",
    parentColumnLabel: "payment manager",
    listResources: (spec) =>
      (spec.payments ?? []).flatMap((manager) =>
        manager.connectors.map((connector) => ({
          resourceType: "payment-connector",
          managerName: manager.name,
          name: connector.name,
          parentName: manager.name,
        })),
      ),
  },
  {
    resourceType: "runtime-endpoint",
    parentColumnLabel: "runtime",
    listResources: (spec) =>
      spec.runtimes.flatMap((runtime) =>
        Object.keys(runtime.endpoints ?? {}).map((name) => ({
          resourceType: "runtime-endpoint",
          runtimeName: runtime.name,
          name,
          parentName: runtime.name,
        })),
      ),
  },
];

const PROJECT_MENU = "/agentcore/project";
const REMOVE_ROOT = "/agentcore/project/remove";

// Nothing to navigate or select on an empty list or the nothing-to-remove message.
const STATIC_KEY_HINTS = [
  { key: "esc", label: "back" },
  { key: "ctrl+c", label: "quit" },
];

const LIST_KEY_HINTS = [
  { key: "↑↓/jk", label: "navigate" },
  { key: "/", label: "filter" },
  { key: "enter", label: "select" },
];

const KEY_HINTS = [...LIST_KEY_HINTS, ...STATIC_KEY_HINTS];

const PAGED_KEY_HINTS = [...LIST_KEY_HINTS, { key: "←→/hl", label: "page" }, ...STATIC_KEY_HINTS];

const RESOURCE_PAGE_SIZE = 10;

function resourceTypeCounts(
  spec: ProjectSpec,
): { resourceType: RemovableResourceType; count: number }[] {
  return RESOURCE_PICKER_CONFIGS.flatMap((config) => {
    const count = config.listResources(spec).length;
    return count > 0 ? [{ resourceType: config.resourceType, count }] : [];
  });
}

// Allow remove-all when the spec is non-empty, including resources that can't be
// exposed for individual removal.
const EXTRA_REMOVE_ALL_COLLECTIONS: { field: keyof ProjectSpec; label: string }[] = [
  { field: "knowledgeBases", label: "knowledge base" },
  { field: "abTests", label: "AB test" },
  { field: "datasets", label: "dataset" },
  { field: "toolRuntimes", label: "MCP runtime tool" },
  { field: "unassignedTargets", label: "unassigned target" },
];

function removeAllRows(spec: ProjectSpec): { label: string; count: number }[] {
  return [
    ...resourceTypeCounts(spec).map(({ resourceType, count }) => ({ label: resourceType, count })),
    ...EXTRA_REMOVE_ALL_COLLECTIONS.flatMap(({ field, label }) => {
      const value = spec[field];
      const count = Array.isArray(value) ? value.length : 0;
      return count > 0 ? [{ label, count }] : [];
    }),
  ];
}

export function ProjectRemoveScreen({ ctx, core }: ScreenProps) {
  const { resourceType, resourceIndex } = useParams();
  const navigate = useNavigate();

  return (
    <ProjectGate
      core={core}
      breadcrumb={["agentcore", "project", "remove"]}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(PROJECT_MENU)}
    >
      {(project): ReactElement => {
        if (resourceType === "all") {
          return <RemoveAllConfirm project={project} core={core} />;
        }
        const config = RESOURCE_PICKER_CONFIGS.find((c) => c.resourceType === resourceType);
        if (!config) {
          return <ResourceTypePicker project={project} />;
        }
        if (resourceIndex !== undefined) {
          const resource = config.listResources(project.spec)[Number(resourceIndex)];
          if (resource) {
            return (
              <RemoveConfirm project={project} core={core} config={config} resource={resource} />
            );
          }
        }
        return <ResourcePicker project={project} config={config} />;
      }}
    </ProjectGate>
  );
}

type ResourceTypeRow = Record<string, unknown> & { resourceType: string; count: string };

const resourceTypeColumns = [
  { key: "resourceType", header: "resource", flex: true },
  { key: "count", header: "count", width: 8, align: "right" },
] satisfies DataTableColumn<ResourceTypeRow>[];

function ResourceTypePicker({ project }: { project: Project }) {
  const navigate = useNavigate();

  const rows: ResourceTypeRow[] = resourceTypeCounts(project.spec).map(
    ({ resourceType, count }) => ({
      resourceType,
      count: String(count),
    }),
  );
  const allTotal = removeAllRows(project.spec).reduce((sum, { count }) => sum + count, 0);
  if (allTotal > 0) {
    rows.push({ resourceType: "all", count: String(allTotal) });
  }

  return (
    <Layout
      breadcrumb={["agentcore", "project", "remove"]}
      description={`choose a resource to remove from project ${project.name}`}
      keyHints={rows.length > 0 ? KEY_HINTS : STATIC_KEY_HINTS}
    >
      <DataTable
        borderStyle="none"
        showFooter={false}
        focus
        // The resource-type list is short and bounded, so keep it on one page.
        pageSize={RESOURCE_PICKER_CONFIGS.length + 1}
        columns={resourceTypeColumns}
        data={rows}
        emptyMessage="This project has no resources to remove."
        onSelect={(row) => navigate(`${REMOVE_ROOT}/${row.resourceType}`)}
        onEscape={() => navigate(PROJECT_MENU)}
      />
    </Layout>
  );
}

type ResourceRow = Record<string, unknown> & { index: string; name: string; parentName: string };

function ResourcePicker({
  project,
  config,
}: {
  project: Project;
  config: RemovableResourcePickerConfig;
}) {
  const navigate = useNavigate();
  const rows: ResourceRow[] = config.listResources(project.spec).map((resource, index) => ({
    index: String(index),
    name: resource.name,
    parentName: resource.parentName ?? "",
  }));
  const columns: DataTableColumn<ResourceRow>[] = config.parentColumnLabel
    ? [
        { key: "name", header: "name", flex: true },
        { key: "parentName", header: config.parentColumnLabel, width: 30 },
      ]
    : [{ key: "name", header: "name", flex: true }];

  const keyHints =
    rows.length === 0
      ? STATIC_KEY_HINTS
      : rows.length > RESOURCE_PAGE_SIZE
        ? PAGED_KEY_HINTS
        : KEY_HINTS;

  return (
    <Layout
      breadcrumb={["agentcore", "project", "remove", config.resourceType]}
      description={`choose a ${config.resourceType} to remove`}
      keyHints={keyHints}
    >
      <DataTable
        borderStyle="none"
        showFooter={false}
        focus
        pageSize={RESOURCE_PAGE_SIZE}
        columns={columns}
        data={rows}
        emptyMessage={`This project has no ${config.resourceType} resources.`}
        onSelect={(row) => navigate(`${REMOVE_ROOT}/${config.resourceType}/${row.index}`)}
        onEscape={() => navigate(REMOVE_ROOT)}
      />
    </Layout>
  );
}

function RemoveConfirm({
  project,
  core,
  config,
  resource,
}: {
  project: Project;
  core: ScreenProps["core"];
  config: RemovableResourcePickerConfig;
  resource: RemovableResource;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const removedProject = useRef<Project | null>(null);

  const rows: SummaryRows = {
    type: config.resourceType,
    ...(resource.parentName ? { [config.parentColumnLabel ?? "parent"]: resource.parentName } : {}),
    project: project.name,
  };

  return (
    <ConfirmAction
      breadcrumb={["agentcore", "project", "remove", config.resourceType, resource.name]}
      title={resource.name}
      rows={rows}
      trigger={{
        kind: "confirm",
        message: `Remove ${config.resourceType} '${resource.name}' from project ${project.name}?`,
      }}
      isPending={false}
      error={null}
      action={async () => {
        const result = await core.projectManager.removeResource(project, resource);
        removedProject.current = result.project;
        return {
          rows: {
            removed: `${config.resourceType} '${resource.name}'`,
            ...(shouldShowAppCodeNotice(resource.resourceType)
              ? { notes: APP_CODE_RETAINED_NOTICE }
              : {}),
            ...(result.removedEnvKeys.length > 0
              ? { "env removed": result.removedEnvKeys.join(", ") }
              : {}),
          },
        };
      }}
      successTitle="Resource removed"
      runningLabel="Removing resource…"
      onCancel={() => navigate(`${REMOVE_ROOT}/${config.resourceType}`)}
      onDone={() => {
        // On the way out (not mid-action, which would drop the success panel), hand the
        // picker the post-removal project — the seeded query won't refetch on its own.
        if (removedProject.current) {
          queryClient.setQueryData(projectQueryKey(), removedProject.current);
        }
        navigate(REMOVE_ROOT);
      }}
    />
  );
}

function RemoveAllConfirm({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const removedProject = useRef<Project | null>(null);

  const rows = removeAllRows(project.spec);
  const nothingToRemove = rows.length === 0;
  useInput(
    (_input, key) => {
      if (key.escape) navigate(REMOVE_ROOT);
    },
    { isActive: nothingToRemove },
  );
  if (nothingToRemove) {
    return (
      <Layout breadcrumb={["agentcore", "project", "remove", "all"]} keyHints={STATIC_KEY_HINTS}>
        <Text dimColor>This project has no resources to remove.</Text>
      </Layout>
    );
  }

  const summary: SummaryRows = Object.fromEntries(
    rows.map(({ label, count }) => [label, String(count)]),
  );

  return (
    <ConfirmAction
      breadcrumb={["agentcore", "project", "remove", "all"]}
      title={project.name}
      rows={summary}
      trigger={{
        kind: "confirm",
        message: `Remove every resource from project ${project.name}?`,
      }}
      isPending={false}
      error={null}
      onCancel={() => navigate(REMOVE_ROOT)}
      action={async () => {
        const result = await core.projectManager.removeAllResources(project);
        removedProject.current = result.project;
        return {
          rows: {
            removed: "all resources",
            notes: APP_CODE_RETAINED_NOTICE,
            ...(result.removedEnvKeys.length > 0
              ? { "env removed": result.removedEnvKeys.join(", ") }
              : {}),
          },
        };
      }}
      successTitle="All resources removed"
      runningLabel="Removing all resources…"
      onDone={() => {
        if (removedProject.current) {
          queryClient.setQueryData(projectQueryKey(), removedProject.current);
        }
        navigate(REMOVE_ROOT);
      }}
    />
  );
}
