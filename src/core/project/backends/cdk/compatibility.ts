import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import semver from "semver";
import type { Project } from "../../../../handlers/project/types";
import { ProjectStateError } from "../../../../errors";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

/** Reject CDK versions that would silently strip externally managed build roles. */
export function assertContainerBuildRoleSupport(cdkDirectory: string, spec: Project["spec"]): void {
  const fields = ["containerBuildRoleArn", "containerBuildHandlerRoleArn"] as const;
  const required = fields.filter((field) =>
    spec.runtimes.some((runtime) => runtime[field] !== undefined),
  );
  if (required.length === 0) return;

  const projectRequire = createRequire(join(cdkDirectory, "package.json"));
  const cdk = projectRequire("@aws/agentcore-cdk") as {
    AgentEnvSpecSchema?: { shape?: Record<string, unknown> };
  };
  if (required.some((field) => !(field in (cdk.AgentEnvSpecSchema?.shape ?? {})))) {
    throw new ProjectStateError(
      "The installed @aws/agentcore-cdk does not support externally managed container-build roles. " +
        "Install a CDK package with container-build role support before building or deploying this project.",
    );
  }
}

export async function cdkCompatibilityWarning(cdkDirectory: string): Promise<string | undefined> {
  const packagePath = join(cdkDirectory, "node_modules", "@aws", "agentcore-cdk", "package.json");

  let installedVersion: unknown;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: unknown;
    };
    installedVersion = packageJson.version;
  } catch {
    return undefined;
  }

  if (
    typeof installedVersion !== "string" ||
    semver.valid(installedVersion) === null ||
    !semver.lt(installedVersion, MINIMUM_COMPATIBLE_CDK_VERSION)
  ) {
    return undefined;
  }

  return (
    `This project uses @aws/agentcore-cdk ${installedVersion}, but this CLI requires ` +
    `${MINIMUM_COMPATIBLE_CDK_VERSION} or newer for full compatibility. ` +
    `Update the CDK dependency, then rebuild or redeploy.`
  );
}
