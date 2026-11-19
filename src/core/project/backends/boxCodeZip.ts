import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import {
  boxNetworkEdits,
  runtimeProfileWriter,
  writeBoxNetworkFiles,
  writeRenderedBoxFiles,
} from "../boxNetworkWriters";
import { BOX_CODEZIP_DIST, runtimeRunsInBox } from "../templates/boxProfile";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";

/**
 * Stages box into each CodeZip runtime that runs in a box ({@link runtimeRunsInBox}),
 * so the zip carries it: `<codeLocation>/.box-dist/` gets box, its helpers, its
 * packs, the libffi shim built for the runtime's Python, and what the runtime
 * profile writer writes from the runtime's Box network model (the Runtime profile
 * and a byte copy of each policy file it names). `.box/<name>/aws/` gets only what
 * the writer writes, for people to read. Both folders are rewritten on every build
 * and deploy. `box` is asked for only when a runtime needs it. Returns the names
 * of the runtimes it staged.
 */
export async function stageBoxCodeZip(
  project: Project,
  networks: readonly BoxNetwork[],
  box: (version: string | undefined) => Promise<BoxLinuxBuild>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter(
    (runtime) => runtime.build === "CodeZip" && runtimeRunsInBox(project.spec, runtime),
  );
  if (runtimes.length === 0) return [];
  const staged = runtimes.map((runtime) => ({
    runtime: runtime.name,
    dist: posix.join(runtime.codeLocation, BOX_CODEZIP_DIST),
    // A CodeZip deploy reads the deployed resources, its Python and its code path through the
    // @box/agentcore and @box/agentcore-codezip packs.
    kind: "codezip" as const,
  }));
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
    envLocal: {},
  });
  const filesOf = (dist: string) => files.filter(({ path }) => path.startsWith(`${dist}/`));
  // One build for each box version the runtimes name, so each downloads once.
  const builds = new Map<string | undefined, BoxLinuxBuild>();
  for (const runtime of runtimes) {
    const version = runtime.box?.version;
    if (!builds.has(version)) builds.set(version, await box(version));
  }

  for (const { runtime, dist } of staged) {
    const entry = runtimes.find(({ name }) => name === runtime)!;
    const build = builds.get(entry.box?.version)!;
    const folder = join(project.rootPath, ...dist.split("/"));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const binary of BOX_BINARIES) {
      copyFileSync(join(build.binaries, binary), join(folder, binary));
      chmodSync(join(folder, binary), 0o755);
    }
    cpSync(build.resources, join(folder, "resources"), { recursive: true });
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
    writeRenderedBoxFiles(project.rootPath, runtime, dist, filesOf(dist));
  }
  return runtimes.map((runtime) => runtime.name);
}
