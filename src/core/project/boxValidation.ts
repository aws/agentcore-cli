/**
 * The rules a runtime that runs in a box ({@link runsInBox}) must keep, so that it does not run its
 * agent with no box. The runtime sync asks the sync rules before it writes agentcore.json, and
 * build and deploy call {@link validateBoxRuntimes} before they read the box profiles.
 */
import { ProjectStateError, RegionUnsupportedFeatureError } from "../../errors/errors";
import { isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
import { supportsRuntimeV2 } from "../partition";
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
 * Throws for a deploy to a region where AgentCore Runtime has no platformVersion V2 when a runtime
 * asks for V2 (`"platformVersion": "V2"`): CloudFormation could not create it there, and would fail
 * only partway through the deploy. Every runtime of a Box project asks for V2, as the project schema
 * requires, so this covers Box runtimes too. A project with no such runtime is let through, an
 * empty one included, as deploying it is how its stack is removed. `target` is a configured
 * target, or, with `provisioning`, the default target deploy is about to create in that region;
 * `otherTargets` says whether aws-targets.json has targets to deploy to.
 */
export function assertRuntimeV2RegionSupported(
  spec: ProjectSpec,
  target: { name: string; region: string },
  {
    provisioning = false,
    otherTargets = false,
  }: { provisioning?: boolean; otherTargets?: boolean } = {},
): void {
  if (supportsRuntimeV2(target.region)) return;
  const onV2 = spec.runtimes
    .filter((runtime) => runtime.platformVersion === BOX_PLATFORM_VERSION)
    .map((runtime) => `'${runtime.name}'`);
  if (onV2.length === 0) return;
  const wayOut = provisioning
    ? otherTargets
      ? "Deploy with --region set to a region that has it, or with --target set to a target in " +
        "another region, then retry."
      : "Deploy with --region set to a region that has it, or add a target in another region to " +
        "agentcore/aws-targets.json, then retry."
    : `Change the region of target '${target.name}' in agentcore/aws-targets.json, or deploy ` +
      "with --target to a target in another region, then retry.";
  const asks = onV2.length === 1 ? "it asks" : "they ask";
  const why = isBoxProject(spec)
    ? "Box runs on AgentCore Runtime V2"
    : `${asks} for AgentCore Runtime V2`;
  throw new RegionUnsupportedFeatureError(
    `Cannot deploy runtime ${onV2.join(", ")} of project '${spec.name}' to target ` +
      `'${target.name}' in ${target.region}: ${why} ("platformVersion": ` +
      `"${BOX_PLATFORM_VERSION}"), which is not available in ${target.region}. ${wayOut}`,
  );
}
