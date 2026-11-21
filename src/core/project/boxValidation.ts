/**
 * The rules a runtime that runs in a box ({@link runsInBox}) must keep, so that it does not run its
 * agent with no box. The runtime sync asks the sync rules before it writes agentcore.json, and
 * build and deploy call {@link validateBoxRuntimes} before they read the box profiles.
 */
import { ProjectStateError } from "../../errors/errors";
import { isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { BOX_PLATFORM_VERSION, type ProjectRuntime } from "../../projectSchemas/runtime";
import { BOX_RELEASE } from "./backends/boxRelease";
import { BOX_CODEZIP_ENTRYPOINT, runsInBox } from "./templates/boxProfile";

/** The box template whose image starts box itself, for a runtime that needs a container build. */
const BOX_CONTAINER_TEMPLATE = "agent-python-strands-box-container";

/**
 * Whether the runtime sync keeps the entrypoint of `runtime`: a CodeZip runtime that runs in a box
 * starts box with start.py, and its box profile runs the agent. So `[tool.agentcore] entrypoint`
 * names the agent, not the entry point AgentCore Runtime runs.
 */
export function syncKeepsBoxEntrypoint(boxProject: boolean, runtime: ProjectRuntime): boolean {
  return (
    runsInBox(boxProject, runtime) &&
    runtime.build === "CodeZip" &&
    runtime.entrypoint === BOX_CODEZIP_ENTRYPOINT
  );
}

/** The warning the runtime sync gives when it keeps start.py over the manifest's `entrypoint`. */
export function keptBoxEntrypointWarning(runtimeName: string, reason: string, value: string) {
  return (
    `runtime "${runtimeName}" runs its agent in a box, so its entrypoint stays ` +
    `${BOX_CODEZIP_ENTRYPOINT}, which starts box, and its box profile runs the agent. ` +
    `${reason} names ${value}, which is not used.`
  );
}

/**
 * Throws when the runtime sync would switch `runtime`, a CodeZip runtime that runs in a box, to a
 * container build because of the Dockerfile in `contextLabel`. The runtime keeps its box profile
 * and Box gateway, but the user's Dockerfile does not start box, and the CodeZip box profile does
 * not run an agent in an image. So the agent would run with no box.
 */
export function assertNoBoxContainerSwitch(
  boxProject: boolean,
  runtime: ProjectRuntime,
  contextLabel: string,
): void {
  if (!runsInBox(boxProject, runtime) || runtime.build !== "CodeZip") return;
  throw new ProjectStateError(
    `runtime "${runtime.name}" runs its agent in a box as a CodeZip agent, but ${contextLabel} ` +
      "has a Dockerfile, which would make it a container build that runs the agent with no box. " +
      `Remove the Dockerfile, or create the agent from the ${BOX_CONTAINER_TEMPLATE} template, ` +
      "whose image starts box.",
  );
}

/**
 * Throws for a runtime of a Box project with no `box.version`. Every runtime of a Box project runs
 * in a box, and only `box.version` makes it do so, so without it build would stage no box and the
 * agent could not start on AgentCore Runtime. `agentcore create` writes it with the box release
 * this CLI pins.
 */
export function assertBoxRuntimesHaveBoxVersion(spec: ProjectSpec): void {
  if (!isBoxProject(spec)) return;
  for (const runtime of spec.runtimes) {
    if (runtime.box !== undefined) continue;
    throw new ProjectStateError(
      `runtime "${runtime.name}" has no box.version in agentcore.json, but every runtime of a Box ` +
        `project runs in a box. Add "box": { "version": "${BOX_RELEASE.version}" } to the ` +
        "runtime in agentcore.json, then retry.",
    );
  }
}

/**
 * Throws for a CodeZip runtime that runs in a box but whose entrypoint is not start.py. Only
 * start.py starts box on AgentCore Runtime, so another entrypoint would run the agent with no
 * box, while build still writes its box profile and Box gateway.
 */
export function assertBoxCodeZipRuntimesStartBox(spec: ProjectSpec): void {
  for (const runtime of spec.runtimes) {
    if (runtime.build !== "CodeZip" || !runsInBox(isBoxProject(spec), runtime)) continue;
    const [file = ""] = runtime.entrypoint.split(":");
    if (file === BOX_CODEZIP_ENTRYPOINT) continue;
    throw new ProjectStateError(
      `runtime "${runtime.name}" runs its agent in a box (it has box.version in agentcore.json), ` +
        `but its entrypoint is ${runtime.entrypoint}, so AgentCore Runtime would run the agent ` +
        `with no box. Set "entrypoint": "${BOX_CODEZIP_ENTRYPOINT}" for the runtime in ` +
        `agentcore.json, and keep ${BOX_CODEZIP_ENTRYPOINT} in ${runtime.codeLocation}, then retry.`,
    );
  }
}

/**
 * The checks build and deploy run on the synced `spec`, before they read the box profiles or
 * write anything: every runtime of a Box project has `box.version`, and each CodeZip one starts
 * box.
 */
export function validateBoxRuntimes(spec: ProjectSpec): void {
  assertBoxRuntimesHaveBoxVersion(spec);
  assertBoxCodeZipRuntimesStartBox(spec);
}

/**
 * Throws for a runtime of a Box project whose `platformVersion` is not `"V2"`. Box runs only on
 * AgentCore Runtime V2, and without the field the service picks the platform, which can be V1.
 * `agentcore create` and `add runtime` write it. Build and deploy call this before the runtime
 * sync rewrites agentcore.json.
 */
export function assertBoxRuntimesOnRuntimeV2(spec: ProjectSpec): void {
  if (!isBoxProject(spec)) return;
  for (const runtime of spec.runtimes) {
    if (runtime.platformVersion === BOX_PLATFORM_VERSION) continue;
    const actual =
      runtime.platformVersion === undefined
        ? "has no platformVersion"
        : `has "platformVersion": "${runtime.platformVersion}"`;
    throw new ProjectStateError(
      `runtime "${runtime.name}" ${actual} in agentcore.json, but every runtime of a Box project ` +
        `runs on AgentCore Runtime ${BOX_PLATFORM_VERSION}. Set "platformVersion": ` +
        `"${BOX_PLATFORM_VERSION}" on the runtime in agentcore.json, then retry.`,
    );
  }
}
