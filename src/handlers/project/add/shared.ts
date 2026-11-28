import { InputValidationError } from "../../../errors";
import { type AwsDeploymentTarget, DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { type ChinaAddKind, isAddableInChina } from "../../../core/project/manager";
import type { Context } from "../../../router";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey, RegionKey } from "../../keys";
import { renderResult } from "../../utils";
import {
  projectMutationResource,
  projectReference,
  type ProjectMutationResult,
  type ProjectMutationResourceType,
} from "../output";
import type { AddResourceInput, Project } from "../types";
import { isBoundGateway } from "../../../projectSchemas/project";
import type { AddProjectResourceConfig } from "./types";

/**
 * The note on the help of every `add` subcommand whose kind is not in the
 * project manager's China allowlist. The add menu's China alert quotes it.
 */
export const CN_UNAVAILABLE_NOTE = "not available in China regions";

/**
 * The help description of an `add` subcommand. Every add handler declares its
 * description through this with the {@link ChinaAddKind} it adds, so the note
 * follows the project manager's allowlist (`isAddableInChina`): a kind added
 * later is marked "(not available in China regions)" in `--help`, the add menu
 * and command.md until the allowlist says otherwise.
 */
export function addDescription(kind: ChinaAddKind, description: string): string {
  return isAddableInChina(kind) ? description : `${description} (${CN_UNAVAILABLE_NOTE})`;
}

type AddProjectResourceResultOptions = {
  resourceType?: ProjectMutationResourceType;
  notes?: string[];
};

/**
 The L3 deploys `<project><sep><target><sep><name>` and fails at synth past the service cap. This fails at add time using the longest declared target, or "default" when none is declared yet. With the `_` separator the L3 writes the target's hyphens as underscores, which keeps the length.
**/
export function requireDeployedNameFits(
  kind: string,
  projectName: string,
  name: string,
  separator: "_" | "-",
  maxLength: number,
  targets: readonly AwsDeploymentTarget[],
): void {
  const longest = [DEFAULT_TARGET_NAME, ...targets.map((target) => target.name)].reduce((a, b) =>
    b.length > a.length ? b : a,
  );
  const target = separator === "_" ? longest.replaceAll("-", "_") : longest;
  const deployed = [projectName, target, name].join(separator);
  if (deployed.length <= maxLength) return;
  throw new InputValidationError(
    `${kind} deployed name '${deployed}' is ${deployed.length} characters. The maximum is ${maxLength}. The deployed name is <project>${separator}<target>${separator}<name>, checked with the longest declared target '${longest}'. Shorten the ${kind.toLowerCase()} name.`,
  );
}

export async function addProjectResource(
  ctx: Context,
  config: AddProjectResourceConfig,
  project: Project,
  input: AddResourceInput,
  humanSuccessMessage: string,
  options: AddProjectResourceResultOptions = {},
): Promise<Project> {
  // Same driver as create, build, and deploy: a live step list in a TTY, and
  // plain line-per-step output when stderr is not a TTY or --json wants no ANSI
  // on it.
  const updatedProject = await runWithProgress(
    config.projectManager.addResource(project, input, { region: ctx.value(RegionKey) }),
    {
      io: config.io,
      interactive: ctx.require(JsonKey) ? false : undefined,
    },
  );

  renderResult<ProjectMutationResult>(
    ctx,
    {
      operation: "add",
      project: projectReference(updatedProject),
      resource: projectMutationResource(
        options.resourceType ?? input.resourceType,
        input.resourceConfig.name,
        input,
      ),
      ...(options.notes?.length ? { notes: options.notes } : {}),
    },
    () => {
      config.io.stderr.write(`${humanSuccessMessage}\n`);
      for (const note of options.notes ?? []) config.io.stderr.write(`${note}\n`);
    },
  );

  return updatedProject;
}

/**
 * The gateway the add gateway-target and add gateway-connector wizards select first: the first
 * unbound gateway, which serves every runtime and harness. Only when every gateway is bound
 * (each Box gateway is), the first one.
 */
export function defaultGatewayChoice(
  gateways: readonly { name: string; boundRuntime?: string }[],
): string {
  return (gateways.find((gateway) => !isBoundGateway(gateway)) ?? gateways[0])?.name ?? "";
}

/** " · bound to runtime 'x'" for a gateway bound to one runtime, for a wizard's choice text. */
export function boundRuntimeNote(gateway: { boundRuntime?: string }): string {
  return isBoundGateway(gateway) ? ` · bound to runtime '${gateway.boundRuntime}'` : "";
}

/**
 * The notes of add gateway-target and add gateway-connector for a gateway bound to one runtime:
 * only that runtime gets its variables. They go through `addProjectResource`'s `notes`, so stderr
 * and the `notes` of the `--json` result both carry them. The wizards show the same fact with
 * {@link boundRuntimeNote}.
 */
export function boundGatewayAddedNotes(project: Project, gatewayName: string): string[] {
  const runtime = project.spec.agentCoreGateways.find(
    (gateway) => gateway.name === gatewayName,
  )?.boundRuntime;
  return runtime === undefined
    ? []
    : [
        `Gateway '${gatewayName}' is bound to runtime '${runtime}', so only that runtime gets its variables`,
      ];
}
