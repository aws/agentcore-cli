import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { ProjectStateError } from "../../../../errors";
import { ProcessFailedError, runProcess, type ProcessRunner } from "../../../../io";
import type { WorkloadBuilds } from "../../../../handlers/project/types";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

/** CDK package features a project can depend on beyond the minimum version. */
export type CdkFeature = "ContainerLocal" | "Runtime containerUri";

/** The first @aws/agentcore-cdk release with each feature. */
export const CDK_FEATURE_RELEASES: Record<CdkFeature, string> = {
  ContainerLocal: "1.2.0",
  "Runtime containerUri": "1.3.0",
};

// Runs in Node, like the CDK app: a standalone CLI binary cannot reliably resolve
// the project's external modules through its compiled-in Bun resolver. Prints the
// features the installed @aws/agentcore-cdk lacks on its own stdout line after
// PROBE_RESULT_PREFIX, so Node warnings or preload output around it are ignored.
const PROBE_RESULT_PREFIX = "agentcore-cdk-probe-result:";
const FEATURE_PROBE = `
const { createRequire } = require("node:module");
const { join } = require("node:path");
const wanted = JSON.parse(process.argv[1]);
const loadError = (error) => ({ loadError: error instanceof Error ? error.message : String(error) });
function probe() {
  const projectRequire = createRequire(join(process.cwd(), "package.json"));
  let cdk = {};
  // Only a package that cannot be resolved at all falls through to "update the
  // dependency". A resolved package that fails to load (a dependency of it missing,
  // or it throws) is a broken install, which that advice would hide.
  let resolved = true;
  try {
    projectRequire.resolve("@aws/agentcore-cdk");
  } catch (error) {
    const code = error && error.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return loadError(error);
    resolved = false;
  }
  if (resolved) {
    try {
      cdk = projectRequire("@aws/agentcore-cdk");
    } catch (error) {
      return loadError(error);
    }
  }
  const supported = {
    ContainerLocal: () =>
      Boolean(cdk.BuildTypeSchema?.safeParse("ContainerLocal").success && cdk.LocalContainerImageAsset),
    // Older Runtime schemas strip containerUri, which would silently build with CodeBuild.
    "Runtime containerUri": () => {
      const containerUri = "123456789012.dkr.ecr.us-west-2.amazonaws.com/compatibility:probe";
      const parsed = cdk.AgentEnvSpecSchema?.safeParse({
        name: "compatibility_probe",
        build: "Container",
        entrypoint: "main.py",
        codeLocation: "app/compatibility_probe",
        containerUri,
      });
      return Boolean(parsed?.success && parsed.data.containerUri === containerUri);
    },
  };
  return {
    missing: wanted.filter((feature) => {
      try {
        return !supported[feature]();
      } catch {
        return true;
      }
    }),
  };
}
process.stdout.write("\\n${PROBE_RESULT_PREFIX}" + JSON.stringify(probe()) + "\\n");
`;

/** The CDK features a project's workloads use. A Harness containerUri predates both. */
export function cdkFeaturesFor(builds: WorkloadBuilds): CdkFeature[] {
  const entries = Object.entries(builds);
  return [
    ...(entries.some(([, build]) => build === "ContainerLocal")
      ? (["ContainerLocal"] as const)
      : []),
    ...(entries.some(([key, build]) => key.startsWith("runtime/") && build === "ContainerUri")
      ? (["Runtime containerUri"] as const)
      : []),
  ];
}

/**
 * Verifies in one Node probe that the project's @aws/agentcore-cdk supports every
 * feature in `features`, so an older or missing package never silently drops a
 * setting. Detects support directly, so prereleases and local packages also work.
 * A package that is installed but fails to load is reported with its own error.
 * When the CLI manages the CDK dependencies it installs the version it vends and
 * rejects a newer pin, so the fix is a newer CLI; otherwise it is a newer package.
 */
export async function assertCdkFeatureSupport(
  cdkDirectory: string,
  features: readonly CdkFeature[],
  runner: ProcessRunner = runProcess,
  { dependenciesManaged = true }: { dependenciesManaged?: boolean } = {},
): Promise<void> {
  if (features.length === 0) return;
  let output = "";
  let result: { missing?: CdkFeature[]; loadError?: string };
  try {
    await runner(["node", "--input-type=commonjs", "-e", FEATURE_PROBE, JSON.stringify(features)], {
      cwd: cdkDirectory,
      onOutput: (chunk) => {
        output += chunk;
      },
    });
  } catch (error) {
    // Report the failure itself, never the command line (it holds the whole probe).
    const exitCode = error instanceof ProcessFailedError ? error.meta.exitCode : undefined;
    if (exitCode === null && (error as Error).message.includes("ENOENT")) {
      throw new ProjectStateError(
        "Node.js was not found on your PATH; it is required to check the @aws/agentcore-cdk " +
          `package installed in ${cdkDirectory}. Install Node.js, then rebuild or redeploy.`,
      );
    }
    throw new ProjectStateError(
      `Cannot load @aws/agentcore-cdk from ${cdkDirectory}: the Node.js check failed` +
        `${typeof exitCode === "number" ? ` (exit code ${exitCode})` : ""}.` +
        (output.trim() ? `\n\n${output.trim()}` : ""),
    );
  }
  const resultLine = output.split(/\r?\n/).findLast((line) => line.startsWith(PROBE_RESULT_PREFIX));
  try {
    result = JSON.parse(resultLine?.slice(PROBE_RESULT_PREFIX.length) ?? "") as typeof result;
  } catch {
    throw new ProjectStateError(
      `Cannot load @aws/agentcore-cdk from ${cdkDirectory}: the Node.js check printed no result.` +
        (output.trim() ? `\n\n${output.trim()}` : ""),
    );
  }
  if (result.loadError !== undefined) {
    throw new ProjectStateError(
      `Cannot load @aws/agentcore-cdk from ${cdkDirectory}: ${result.loadError}`,
    );
  }
  const missing = result.missing ?? [];
  if (missing.length === 0) return;
  const minimum = semver.sort(missing.map((feature) => CDK_FEATURE_RELEASES[feature])).at(-1)!;
  const unsupported =
    `This project uses ${missing.join(" and ")}, which its @aws/agentcore-cdk package does not ` +
    `support; ${missing.length === 1 ? "it needs" : "they need"} @aws/agentcore-cdk ${minimum} or newer.`;
  throw new ProjectStateError(
    dependenciesManaged
      ? `${unsupported} The CLI installs the @aws/agentcore-cdk version it ships with, so update ` +
          "the CLI (agentcore update), then rebuild or redeploy."
      : `${unsupported} Install @aws/agentcore-cdk ${minimum} or newer in ${cdkDirectory} ` +
          "(npm install), then rebuild or redeploy.",
  );
}

/** The `@aws/agentcore-cdk` version installed in `node_modules`, if it can be read. */
export async function installedCdkVersion(cdkDirectory: string): Promise<string | undefined> {
  const packagePath = join(cdkDirectory, "node_modules", "@aws", "agentcore-cdk", "package.json");
  try {
    const { version } = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function cdkCompatibilityWarning(cdkDirectory: string): Promise<string | undefined> {
  const installedVersion = await installedCdkVersion(cdkDirectory);
  if (
    installedVersion === undefined ||
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
