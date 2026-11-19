import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStateError } from "../../../errors/errors";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_CONTAINER_START, BOX_RUNTIME_MODULE, boxRuntimeMounts } from "../boxRuntime";
import { isFile } from "../runtimeBuild";
import { defaultSource, type AssetSource } from "../source";

/** Assets are resolved through AssetSource so packaged and standalone CLI builds behave alike. */
export async function stageBoxRuntimeAssets(
  folder: string,
  container: boolean,
  source: AssetSource = defaultSource(),
): Promise<void> {
  const names = container ? [BOX_RUNTIME_MODULE, BOX_CONTAINER_START] : [BOX_RUNTIME_MODULE];
  const contents = await Promise.all(
    names.map((name) => source.read(`templates/box-codezip/${name}`)),
  );
  for (const [index, name] of names.entries()) writeFileSync(join(folder, name), contents[index]!);
}

/**
 * An old/custom eager launcher cannot serve the deferred profile's private ingress. Fail before
 * staging it rather than overwriting a user's startup code or deploying an unreachable runtime.
 */
function compatibleContainerLauncher(text: string): boolean {
  // Inspect only the final build stage. Comments cannot opt an eager entrypoint into this path.
  const instructions = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const lastStage = instructions.findLastIndex((line) => /^FROM\s/i.test(line));
  const stage = instructions.slice(lastStage + 1).filter((line) => line && !line.startsWith("#"));
  const entrypoint = stage.findLast((line) => /^ENTRYPOINT\s/i.test(line));
  if (!entrypoint) return false;
  try {
    const argv: unknown = JSON.parse(entrypoint.replace(/^ENTRYPOINT\s+/i, ""));
    if (
      JSON.stringify(argv) !==
      JSON.stringify([
        "/usr/local/bin/python",
        "/home/bedrock_agentcore/box-profile/box_container_start.py",
      ])
    )
      return false;
  } catch {
    return false;
  }
  return stage.some((line) =>
    /^COPY\s+(?:(?:--chown=\S+|--chmod=\S+|--link)\s+)*(?:\.box-dist|\$\{BOX_DIST\})\/?\s+\/home\/bedrock_agentcore\/box-profile\/?$/i.test(
      line,
    ),
  );
}

export async function assertBoxStorageLauncher(
  runtime: ProjectRuntime,
  launcher: string,
  source: AssetSource = defaultSource(),
): Promise<void> {
  if (boxRuntimeMounts(runtime).length === 0) return;
  const container = runtime.build === "Container";
  const asset = container
    ? "templates/agent-python-strands-box/Dockerfile.template"
    : "templates/box-codezip/start.py";
  const expected = await source.read(asset);
  if (isFile(launcher)) {
    const text = readFileSync(launcher, "utf8");
    if (container ? compatibleContainerLauncher(text) : text.trim() === expected.trim()) return;
  }
  throw new ProjectStateError(
    `runtime "${runtime.name}": ${launcher} is missing, customized, or from an older Box template. ` +
      "Storage requires the generated deferred launcher. Create a temporary project with this CLI's " +
      `matching Box template, copy its ${container ? "Dockerfile" : "start.py"} to ${launcher}, ` +
      "and retry. Keep the agent source and environment unchanged; review any custom startup work " +
      "before replacing this file.",
  );
}
