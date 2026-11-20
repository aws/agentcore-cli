import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessYamlSchema } from "../../../../projectSchemas/harness";
import type {
  LocalWorkloadSources,
  Project,
  WorkloadBuildMode,
  WorkloadBuilds,
  WorkloadKey,
} from "../../../../handlers/project/types";
import { InputValidationError, ProjectStateError } from "../../../../errors";

/**
 * Resolves every workload's build mode from agentcore.json and each harness.yaml,
 * and, for each ContainerLocal workload, where it is built from and its execution
 * role. It reads the harness files, so resolve once per command and pass the
 * result on. A Runtime or Harness with a pre-built image (containerUri) is
 * ContainerUri and is never built locally; a Harness with neither image nor
 * Dockerfile is Managed.
 */
export function resolveWorkloads(project: Project): {
  builds: WorkloadBuilds;
  local: LocalWorkloadSources;
} {
  const builds: WorkloadBuilds = {};
  const local: LocalWorkloadSources = new Map();
  for (const runtime of project.spec.runtimes) {
    builds[`runtime/${runtime.name}`] = runtime.containerUri ? "ContainerUri" : runtime.build;
    if (runtime.containerUri || runtime.build !== "ContainerLocal") continue;
    local.set(`runtime/${runtime.name}`, {
      context: runtime.buildContextPath ?? runtime.codeLocation,
      dockerfile: runtime.dockerfile ?? "Dockerfile",
      ...(runtime.executionRoleArn && { executionRoleArn: runtime.executionRoleArn }),
    });
  }
  for (const entry of project.spec.harnesses) {
    const path = join(project.rootPath, entry.path, "harness.yaml");
    if (!existsSync(path)) continue;
    const parsed = HarnessYamlSchema.safeParse(parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      throw new InputValidationError(
        `Invalid harness.yaml at '${path}': ${z.prettifyError(parsed.error)}`,
        { cause: parsed.error },
      );
    }
    const harness = parsed.data;
    // Keyed by the agentcore.json entry name, as the CDK package keys its metadata.
    const key = `harness/${entry.name}` as const;
    builds[key] =
      harness.build ??
      (harness.dockerfile ? "Container" : harness.containerUri ? "ContainerUri" : "Managed");
    if (harness.build !== "ContainerLocal") continue;
    local.set(key, {
      context: harness.buildContextPath ?? entry.path,
      dockerfile: harness.dockerfile ?? "Dockerfile",
      ...(harness.executionRoleArn && { executionRoleArn: harness.executionRoleArn }),
    });
  }
  return { builds, local };
}

/**
 * A warning naming the ContainerLocal workloads that bring their own execution
 * role. The CLI imports such a role without changing it, so nothing grants it
 * pull access to the CDK bootstrap repository the image is published to.
 */
export function byoExecutionRoleWarning(local: LocalWorkloadSources): string | undefined {
  const keys = [...local].filter(([, source]) => source.executionRoleArn).map(([key]) => key);
  if (keys.length === 0) return undefined;
  return (
    `${keys.join(", ")} ${keys.length === 1 ? "uses" : "use"} ContainerLocal with an existing ` +
    "execution role (executionRoleArn), which the deploy does not modify. That role needs ECR " +
    "pull access to the CDK bootstrap repository the image is published to: " +
    "ecr:GetAuthorizationToken on *, and ecr:BatchGetImage and ecr:GetDownloadUrlForLayer on " +
    "arn:aws:ecr:<region>:<account>:repository/cdk-<qualifier>-container-assets-<account>-<region> " +
    "(the default qualifier is hnb659fds). Otherwise the service cannot pull the image and " +
    "fails at first invoke."
  );
}

/** The workload entries of a build map, with their typed keys. */
export function workloadEntries(builds: WorkloadBuilds): [WorkloadKey, WorkloadBuildMode][] {
  return Object.entries(builds) as [WorkloadKey, WorkloadBuildMode][];
}

export function hasLocalContainerBuilds(builds: WorkloadBuilds): boolean {
  return Object.values(builds).includes("ContainerLocal");
}

type TemplateResource = { Type?: string; Properties?: Record<string, unknown> };
export type DeployedTemplate = {
  Metadata?: Record<string, unknown>;
  Resources?: Record<string, TemplateResource>;
  Outputs?: Record<string, { Export?: { Name?: unknown } }>;
};

/**
 * Finds the build mode a workload was deployed with. Templates synthesized by a
 * CDK package that supports ContainerLocal record it in `agentcore:builds`. Older
 * templates predate ContainerLocal, so a workload found in them is a container
 * image (Container) or a code artifact (CodeZip, or Managed for a Harness); either
 * way it is not ContainerLocal, so switching it to ContainerLocal is rejected.
 * Returns undefined when it was not deployed.
 */
function deployedBuild(
  template: DeployedTemplate,
  recorded: Record<string, unknown> | undefined,
  key: string,
  projectName: string,
  targetName: string | undefined,
): string | undefined {
  const value = recorded?.[key];
  if (value !== undefined) {
    if (typeof value !== "string") {
      throw new ProjectStateError(`Cannot verify the deployed build mode for ${key}.`);
    }
    return value;
  }

  const [kind, name] = key.split("/") as [string, string];
  // Physical names are <project>_<target>_<name>; v0 projects omit the target.
  const physicalName = [
    projectName,
    ...(targetName ? [targetName.replace(/-/g, "_")] : []),
    name,
  ].join("_");
  const [type, nameProperty] =
    kind === "runtime"
      ? ["AWS::BedrockAgentCore::Runtime", "AgentRuntimeName"]
      : ["AWS::BedrockAgentCore::Harness", "HarnessName"];
  const found = Object.values(template.Resources ?? {}).find(
    (resource) => resource.Type === type && resource.Properties?.[nameProperty] === physicalName,
  );
  if (found) {
    const artifact = found.Properties?.[
      kind === "runtime" ? "AgentRuntimeArtifact" : "EnvironmentArtifact"
    ] as { ContainerConfiguration?: unknown } | undefined;
    if (artifact?.ContainerConfiguration !== undefined) return "Container";
    return kind === "runtime" ? "CodeZip" : "Managed";
  }

  // Older vended apps managed the Harness outside CloudFormation; its execution
  // role output still identifies a deployed workload. Its image source is not in
  // the template, so assume a container build and fail closed.
  if (kind === "harness") {
    const roleExport = `-Harness-${name.replaceAll("_", "-")}-RoleArn`;
    const legacyHarness = Object.values(template.Outputs ?? {}).some((output) =>
      JSON.stringify(output.Export?.Name)?.includes(roleExport),
    );
    if (legacyHarness) return "Container";
  }
  return undefined;
}

/**
 * Rejects switching a deployed workload into or out of ContainerLocal, and a
 * deployed Runtime between CodeZip and a container artifact (Container or a
 * pre-built image, ContainerUri). AgentCore rejects an
 * artifact-type change in place ("Agent artifact type cannot be updated"), and
 * Container to ContainerLocal replaces how the image is built and published, so
 * only a new workload may use ContainerLocal. Other ContainerUri changes are
 * left to CloudFormation. The deployed template is authoritative: editing
 * agentcore.json or deleting deployed-state.json must not permit a build-mode
 * migration.
 */
export function assertSupportedBuildTransitions(
  template: DeployedTemplate,
  builds: WorkloadBuilds,
  projectName: string,
  targetName: string | undefined,
): void {
  const recorded = template.Metadata?.["agentcore:builds"];
  if (
    recorded !== undefined &&
    (typeof recorded !== "object" || recorded === null || Array.isArray(recorded))
  ) {
    throw new ProjectStateError(
      "Cannot verify build modes: the deployed template has invalid build metadata.",
    );
  }
  for (const [key, desired] of Object.entries(builds)) {
    const deployed = deployedBuild(
      template,
      recorded as Record<string, unknown> | undefined,
      key,
      projectName,
      targetName,
    );
    if (deployed === undefined || deployed === desired) continue;
    const pair = new Set([deployed, desired]);
    if (pair.has("ContainerLocal") && !pair.has("ContainerUri")) {
      throw new ProjectStateError(
        `Cannot change ${key} from ${deployed} to ${desired}. ` +
          "A deployed workload cannot be switched into or out of ContainerLocal; only a new " +
          `workload can use ContainerLocal. Keep the deployed build mode (${deployed}), or add ` +
          "a workload with a new name. If you removed this workload and added it again under " +
          "the same name, deploy the removal first, then add it again.",
      );
    }
    // The CLI flips a CodeZip Runtime to Container itself when a Dockerfile appears
    // (runtimeBuild.ts); on a deployed Runtime the service then fails the update.
    // A pre-built image (ContainerUri) is a container artifact too.
    if (
      key.startsWith("runtime/") &&
      pair.has("CodeZip") &&
      (pair.has("Container") || pair.has("ContainerUri"))
    ) {
      const keep =
        deployed === "Container"
          ? 'set "build": "Container" and its "dockerfile" in agentcore.json again'
          : deployed === "ContainerUri"
            ? 'set "build": "Container" and its "containerUri" in agentcore.json again'
            : desired === "Container"
              ? 'delete the Dockerfile and set "build": "CodeZip" in agentcore.json'
              : 'remove "containerUri" and set "build": "CodeZip" in agentcore.json';
      throw new ProjectStateError(
        `Cannot change ${key} from ${deployed} to ${desired}. The service does not allow ` +
          "changing a Runtime's artifact type, so the deploy would fail and roll back. Add a " +
          `Runtime with a new name, or keep the deployed build: ${keep}.`,
      );
    }
  }
}
