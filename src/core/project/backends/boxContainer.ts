import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { isFile } from "../runtimeBuild";
import { renderRuntimeBoxProfile, runsBoxStartScript } from "../templates/boxProfile";

/** The folder a box image's Dockerfile copies its box profile from, in the build context. */
export const BOX_IMAGE_DIST = ".box-dist";

/** The folder a container runtime's image builds from. */
export function containerBuildContext(projectRoot: string, runtime: ProjectRuntime): string {
  return join(projectRoot, runtime.buildContextPath ?? runtime.codeLocation);
}

/** Whether a container runtime's Dockerfile copies the staged box in. */
export function imageCopiesBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  if (runtime.build !== "Container") return false;
  const dockerfile = join(
    containerBuildContext(projectRoot, runtime),
    runtime.dockerfile ?? "Dockerfile",
  );
  return isFile(dockerfile) && readFileSync(dockerfile, "utf8").includes(`${BOX_IMAGE_DIST}/`);
}

/**
 * Writes `<context>/.box-dist/profile.toml` for a box image: `profile`, the
 * text of the profile the image runs. The image's Dockerfile installs box
 * itself, from the box release. The folder is rewritten each time.
 */
export function stageBoxImage(context: string, profileText: string): void {
  const dist = join(context, BOX_IMAGE_DIST);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "profile.toml"), profileText);
}

/**
 * Stages box for build and deploy into each container runtime whose
 * Dockerfile copies `.box-dist/`, with the AgentCore Runtime profile rendered
 * from agentcore.json. Returns the names of the runtimes it staged.
 */
export function stageBoxContainers(project: Project): string[] {
  const runtimes = project.spec.runtimes.filter((runtime) =>
    imageCopiesBox(project.rootPath, runtime),
  );
  for (const runtime of runtimes) {
    stageBoxImage(
      containerBuildContext(project.rootPath, runtime),
      renderRuntimeBoxProfile(project.spec, runtime),
    );
  }
  return runtimes.map((runtime) => runtime.name);
}

/**
 * Whether a runtime runs its agent in a box on AgentCore Runtime: a CodeZip
 * runtime whose entry point is the box start script, or a container runtime
 * whose Dockerfile copies `.box-dist/`.
 */
export function runsAgentInBox(projectRoot: string, runtime: ProjectRuntime): boolean {
  return (
    (runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint)) ||
    imageCopiesBox(projectRoot, runtime)
  );
}
