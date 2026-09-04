import { FeatureFlagsKey, type Context } from "../../router";
import { declaresNothingDeployable, isHarnessOnlyProject } from "./deploy";
import type { DeploymentMode, Project } from "./types";

/**
 * Whether the imperative path can take this project: it declares harnesses and
 * nothing else, or it declares nothing at all (a teardown of whatever the
 * target's state records). A project with any other resource stays on CDK.
 */
function imperativeApplies(project: Project): boolean {
  return isHarnessOnlyProject(project) || declaresNothingDeployable(project);
}

/**
 * Which path a deploy takes. Imperative only when the experiment is switched
 * on AND the path applies to the project; everything else stays on CDK, so a
 * flag set in a shell can never change how a runtime or gateway project
 * deploys. The mode guard in the manager then refuses a mode that differs from
 * the one the target was deployed with.
 */
export function resolveDeploymentMode(ctx: Context, project: Project): DeploymentMode {
  const flags = ctx.value(FeatureFlagsKey);
  return flags?.isEnabled("imperativeDeploy") && imperativeApplies(project) ? "imperative" : "cdk";
}

/**
 * The one-line explanation both entry points show when the flag is on but the
 * project declares resources the imperative path does not handle; undefined
 * when there is nothing to explain.
 */
export function imperativeDeployNotApplicable(ctx: Context, project: Project): string | undefined {
  const flags = ctx.value(FeatureFlagsKey);
  if (!flags?.isEnabled("imperativeDeploy") || imperativeApplies(project)) return undefined;
  return (
    "AGENTCORE_CLI_EXPERIMENTAL_IMPERATIVE_DEPLOY is set, but imperative deploy applies only " +
    `to harness-only projects; project '${project.name}' declares other resources, so the CDK ` +
    "path is being used."
  );
}
