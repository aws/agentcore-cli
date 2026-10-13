import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ProcessRunner } from "../../../io";
import { CDK_LIBRARY_OVERRIDE_ENV } from "../../../handlers/project/migrate/types";
import { synthCommand } from "../backends/cdk/assembly";

/**
 * Development and test override for the `@aws/agentcore-cdk` dependency of the
 * v1 CDK app that `migrate` synthesizes: an npm version or spec, or a path to a
 * tarball or package directory (made absolute, so `npm pack` output in the
 * current directory works). Lets the planner run against an unpublished library
 * build; never needed with a released CLI, whose vended app already pins a
 * library that understands the pinned names.
 */
export { CDK_LIBRARY_OVERRIDE_ENV };

const CDK_LIBRARY = "@aws/agentcore-cdk";

/** Synthesizes the migration workspace's v1 CDK app; returns the cloud assembly directory. */
export type WorkspaceSynthesizer = (
  workspaceDirectory: string,
  options?: { onStep?: (message: string) => void },
) => Promise<string>;

export type WorkspaceSynthesizerConfig = {
  runner: ProcessRunner;
  /** Read for {@link CDK_LIBRARY_OVERRIDE_ENV}; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where a relative override path is resolved from; defaults to the current directory. */
  cwd?: string;
};

/**
 * Installs the v1 CDK app's dependencies in the workspace and synthesizes it,
 * with the same command `agentcore deploy` builds a project with. Only the
 * workspace (a temporary copy) is written to.
 */
export function createWorkspaceSynthesizer(
  config: WorkspaceSynthesizerConfig,
): WorkspaceSynthesizer {
  const env = config.env ?? process.env;
  return async (workspaceDirectory, options = {}) => {
    const cdkDirectory = join(workspaceDirectory, "agentcore", "cdk");
    const override = env[CDK_LIBRARY_OVERRIDE_ENV]?.trim();
    if (override) {
      await overrideCdkLibrary(cdkDirectory, librarySpec(override, config.cwd ?? process.cwd()));
    }

    options.onStep?.("Installing the v1 CDK app's dependencies (npm install)");
    await config.runner(["npm", "install", "--no-audit", "--no-fund"], { cwd: cdkDirectory });

    options.onStep?.("Synthesizing the v1 CloudFormation templates");
    const assemblyDirectory = join(cdkDirectory, "cdk.out");
    await config.runner(synthCommand(assemblyDirectory), { cwd: cdkDirectory });
    return assemblyDirectory;
  };
}

/** A path (to a tarball or package directory) becomes a `file:` spec; anything else is an npm spec. */
export function librarySpec(override: string, cwd: string): string {
  const looksLikePath =
    override.startsWith(".") ||
    isAbsolute(override) ||
    override.endsWith(".tgz") ||
    existsSync(resolve(cwd, override));
  if (override.startsWith("file:") || !looksLikePath) return override;
  return `file:${resolve(cwd, override)}`;
}

async function overrideCdkLibrary(cdkDirectory: string, spec: string): Promise<void> {
  const manifestPath = join(cdkDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  manifest.dependencies = { ...manifest.dependencies, [CDK_LIBRARY]: spec };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
