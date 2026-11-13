import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { isFile } from "../runtimeBuild";
import { renderRuntimeBoxProfile, runsBoxStartScript } from "../templates/boxProfile";

/** The folder a box image's Dockerfile copies box from, in the image's build context. */
export const BOX_IMAGE_DIST = ".box-dist";

/** box and the two helper programs it runs, which must sit beside it. */
const BOX_BINARIES = ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"] as const;

/**
 * The Linux arm64 build of box, under AGENTCORE_BOX_SOURCE. Built on Amazon
 * Linux 2023 (glibc 2.34), it also runs in the template's newer Debian image.
 */
const LINUX_BUILD = join("target-al2023", "release");

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
 * Writes `<context>/.box-dist/` for a box image: box, its helpers, its packs,
 * and `profile`, the text of the profile the image runs. The folder is
 * rewritten each time.
 *
 * box comes from AGENTCORE_BOX_SOURCE, a staging-boxy checkout with a Linux
 * build in target-al2023/release, until box ships a Linux release.
 */
export function stageBoxImage(
  context: string,
  profileText: string,
  env: NodeJS.ProcessEnv,
  runtimeName: string,
): void {
  const source = env.AGENTCORE_BOX_SOURCE;
  if (!source) {
    throw new InvalidEnvironmentError(
      `runtime "${runtimeName}" runs its agent in a box, so its image needs box built for Linux. ` +
        `Set AGENTCORE_BOX_SOURCE to the staging-boxy checkout that holds it in ${LINUX_BUILD}.`,
    );
  }
  const binaries = join(source, LINUX_BUILD);
  for (const binary of BOX_BINARIES) {
    if (!isFile(join(binaries, binary))) {
      throw new InvalidEnvironmentError(
        `AGENTCORE_BOX_SOURCE has no ${join(binaries, binary)}. Build box on Amazon Linux 2023 ` +
          `into ${LINUX_BUILD} there, then retry.`,
      );
    }
  }
  const resources = join(source, "resources");
  if (!existsSync(resources)) {
    throw new InvalidEnvironmentError(`AGENTCORE_BOX_SOURCE has no box packs at ${resources}.`);
  }

  const dist = join(context, BOX_IMAGE_DIST);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const binary of BOX_BINARIES) {
    copyFileSync(join(binaries, binary), join(dist, binary));
    chmodSync(join(dist, binary), 0o755);
  }
  cpSync(resources, join(dist, "resources"), { recursive: true });
  writeFileSync(join(dist, "profile.toml"), profileText);
}

/**
 * Stages box for build and deploy into each container runtime whose
 * Dockerfile copies `.box-dist/`, with the AgentCore Runtime profile rendered
 * from agentcore.json. Returns the names of the runtimes it staged.
 */
export function stageBoxContainers(project: Project, env: NodeJS.ProcessEnv): string[] {
  const runtimes = project.spec.runtimes.filter((runtime) =>
    imageCopiesBox(project.rootPath, runtime),
  );
  for (const runtime of runtimes) {
    stageBoxImage(
      containerBuildContext(project.rootPath, runtime),
      renderRuntimeBoxProfile(project.spec, runtime),
      env,
      runtime.name,
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
