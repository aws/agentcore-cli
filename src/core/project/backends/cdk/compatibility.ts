import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { ProjectStateError } from "../../../../errors";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0-rc.3";

export function requireRuntimeCapabilities(cdkDirectory: string, runtimes: ProjectRuntime[]): void {
  const explicit = runtimes.filter(
    (runtime) =>
      runtime.bindingMode ||
      runtime.executionRoleConfig ||
      runtime.connections?.some(
        (connection) => connection.to.type === "memory" && connection.to.name,
      ),
  );
  if (!explicit.length) return;
  try {
    const require = createRequire(join(cdkDirectory, "package.json"));
    const { AgentEnvSpecSchema } = require("@aws/agentcore-cdk") as {
      AgentEnvSpecSchema?: {
        safeParse(value: unknown): { success: boolean; data?: ProjectRuntime };
      };
    };
    for (const runtime of explicit) {
      const result = AgentEnvSpecSchema?.safeParse(runtime);
      if (
        !result?.success ||
        !result.data ||
        !isDeepStrictEqual(result.data.bindingMode, runtime.bindingMode) ||
        !isDeepStrictEqual(result.data.executionRoleConfig, runtime.executionRoleConfig) ||
        !isDeepStrictEqual(result.data.connections, runtime.connections)
      ) {
        throw new Error("Installed CDK schema does not retain the requested runtime capabilities");
      }
    }
  } catch (cause) {
    throw new ProjectStateError(
      "This project requires a companion @aws/agentcore-cdk release supporting explicit runtime bindings and execution-role policies. " +
        "Install it before building or deploying; access restrictions must not be silently stripped.",
      { cause },
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
