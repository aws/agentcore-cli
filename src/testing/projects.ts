import { join } from "node:path";
import { createRootHandler, type RootHandlerConfig } from "../handlers";
import type { Core } from "../handlers/types";
import type { Project } from "../handlers/project/types";
import { inTempDirectory } from "./fs";
import { createSilentLogger } from "./logging";
import { testIO } from "./testIO";
import { TestCoreClient } from "./TestCoreClient";
import { TestGlobalConfigAccessor } from "./globalConfig";

export type InitProjectOptions = {
  /** Project name passed to `agentcore create`. */
  name?: string;
  /** Extra flags appended to the `agentcore create` command, e.g. `["--template", "empty"]`. */
  flags?: string[];
  /** Temp directory prefix, for recognizable paths while debugging. */
  prefix?: string;
  /** Core injected into the root handler; defaults to a fresh {@link TestCoreClient}. */
  core?: Core;
} & Partial<RootHandlerConfig>;

/** A scaffolded project: its name, root path, and a handler that removes it and restores the cwd. */
export type InitializedProject = {
  projectName: string;
  projectRoot: string;
  cleanup: () => Promise<void>;
};

/** Scaffolds a project with `agentcore create` and cds into it so withProject resolves it. */
export async function initProject(options: InitProjectOptions = {}): Promise<InitializedProject> {
  const {
    name = "TestProject",
    flags = [],
    prefix,
    core = new TestCoreClient(),
    ...config
  } = options;
  const { path, cleanup } = await inTempDirectory(prefix);
  try {
    const root = createRootHandler(core, {
      io: testIO().io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
      ...config,
    });
    await root.route([
      "node",
      "agentcore",
      "create",
      "--name",
      name,
      ...flags,
      "--skip-install",
      "--skip-git",
    ]);
    const projectRoot = join(path, name);
    process.chdir(projectRoot);
    return { projectName: name, projectRoot, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function inProjectCore(): TestCoreClient {
  const core = new TestCoreClient();
  core.projectManager.resolve = async () => ({}) as Project;
  return core;
}
