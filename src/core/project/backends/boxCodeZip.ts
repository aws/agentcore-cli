import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { boxNetworkEdits, runtimeProfileWriter, writeBoxNetworkFiles } from "../boxNetworkWriters";
import { BOX_CODEZIP_DIST, boxAwsDir, runsBoxStartScript } from "../templates/boxProfile";
import { BOX_BINARIES, type BoxLinuxBuild } from "./boxRelease";
import { assertBoxStorageLauncher, stageBoxRuntimeAssets } from "./boxRuntimeAssets";

/**
 * Stages box into each CodeZip runtime whose entry point is the box start
 * script. It generates the canonical AWS tree in `.box/<name>/aws/`: box, its
 * helpers, its packs, the libffi shim built for the runtime's Python, and what
 * the runtime profile writer writes from the runtime's Box network model (the
 * Runtime profile and a byte copy of each policy file it names). It then copies
 * that tree into `<codeLocation>/.box-dist/`, so the zip carries it. Both
 * folders are rewritten on every build and deploy. `box` is asked for only when
 * a runtime needs it, after each start.sh passes. Returns the names of the
 * runtimes it staged.
 */
export async function stageBoxCodeZip(
  project: Project,
  networks: readonly BoxNetwork[],
  box: (version: string | undefined) => Promise<BoxLinuxBuild>,
): Promise<string[]> {
  const runtimes = project.spec.runtimes.filter(
    (runtime) => runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint),
  );
  if (runtimes.length === 0) return [];
  for (const runtime of runtimes) {
    await assertBoxStorageLauncher(
      runtime,
      join(project.rootPath, runtime.codeLocation, "start.py"),
    );
  }
  const staged = runtimes.map((runtime) => ({
    runtime: runtime.name,
    dist: boxAwsDir(runtime.name),
    // A CodeZip deploy reads the deployed resources, its Python and its code path through the
    // box/agentcore and box/agentcore-codezip packs, so it is not a container.
    container: false,
    codezip: true,
  }));
  const { files } = boxNetworkEdits([runtimeProfileWriter(staged)], networks, {
    spec: project.spec,
    projectRoot: project.rootPath,
    env: {},
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
    const ffi = entry.runtimeVersion ? build.ffi[entry.runtimeVersion] : undefined;
    if (ffi) cpSync(ffi, join(folder, "ffi"), { recursive: true });
    writeBoxNetworkFiles(project.rootPath, filesOf(dist));
    await stageBoxRuntimeAssets(folder, false);
    // Copy the canonical AWS tree into the code folder's .box-dist so the zip carries it.
    const codeDist = join(project.rootPath, ...entry.codeLocation.split("/"), BOX_CODEZIP_DIST);
    rmSync(codeDist, { recursive: true, force: true });
    cpSync(folder, codeDist, { recursive: true });
  }
  return runtimes.map((runtime) => runtime.name);
}
