import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { ProjectStateError } from "../../../../errors";
import { runProcess, type ProcessRunner } from "../../../../io";
import type { WorkloadBuilds } from "../../../../handlers/project/types";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

/** CDK package features a project can depend on beyond the minimum version. */
export type CdkFeature = "ContainerLocal" | "Runtime containerUri";

const CDK_FEATURE_RELEASES: Record<CdkFeature, string> = {
  ContainerLocal: "aws/agentcore-l3-cdk-constructs#463",
  "Runtime containerUri": "aws/agentcore-l3-cdk-constructs#440",
};

// Runs in Node, like the CDK app: a standalone CLI binary cannot reliably resolve
// the project's external modules through its compiled-in Bun resolver. Prints the
// features the installed @aws/agentcore-cdk lacks, as a JSON array.
const FEATURE_PROBE = `
const { createRequire } = require("node:module");
const { join } = require("node:path");
const wanted = JSON.parse(process.argv[1]);
function probe() {
  let cdk;
  try {
    cdk = createRequire(join(process.cwd(), "package.json"))("@aws/agentcore-cdk");
  } catch (error) {
    // A missing package falls through to "update the dependency". Anything else is a
    // broken install, which that advice would hide.
    const code = error && error.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      return { loadError: error instanceof Error ? error.message : String(error) };
    }
    cdk = {};
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
process.stdout.write(JSON.stringify(probe()));
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
 */
export async function assertCdkFeatureSupport(
  cdkDirectory: string,
  features: readonly CdkFeature[],
  runner: ProcessRunner = runProcess,
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
    result = JSON.parse(output.trim().split(/\r?\n/).pop() ?? "{}") as typeof result;
  } catch (error) {
    result = { loadError: error instanceof Error ? error.message : String(error) };
  }
  if (result.loadError !== undefined) {
    throw new ProjectStateError(
      `Cannot load @aws/agentcore-cdk from ${cdkDirectory}: ${result.loadError}`,
    );
  }
  const missing = result.missing ?? [];
  if (missing.length === 0) return;
  throw new ProjectStateError(
    `This project uses ${missing.join(" and ")}, which its @aws/agentcore-cdk package does not ` +
      `support. Install a release that includes ${missing.map((feature) => CDK_FEATURE_RELEASES[feature]).join(" and ")} ` +
      `in ${cdkDirectory} (npm install), then rebuild or redeploy.`,
  );
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
