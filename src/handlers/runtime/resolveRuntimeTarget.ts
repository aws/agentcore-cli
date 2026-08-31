import { InputValidationError, ResourceNotFoundError } from "../../errors";
import { ExitCode } from "../../runnable";
import type { Context } from "../../router";
import type { CoreOptions } from "../../core/types";
import { DEFAULT_TARGET_NAME } from "../../projectSchemas/aws-targets";
import type { Core } from "../types";
import { coreOptsFromCtx } from "../utils";
import type { Project } from "../project/types";

export interface RuntimeTarget {
  runtimeId: string;
  /** CoreOptions to use for this runtime's CloudWatch reads. */
  options: CoreOptions;
  /** The enclosing project, when the command ran inside one. */
  project?: Project;
}

/**
 * Resolves which runtime an observability command (`runtime logs` /
 * `runtime traces`) addresses. An explicit --id wins and works anywhere; without
 * one the enclosing project's default deployment is resolved through the
 * project manager. Outside a project, --id is required.
 *
 * When resolving automatically, the deployment target's region overrides the
 * ambient one: the stack and its log groups live there.
 */
export async function resolveRuntimeTarget(
  core: Core,
  ctx: Context,
  id: string | undefined,
  cwd: string = process.cwd(),
): Promise<RuntimeTarget> {
  const options = coreOptsFromCtx(ctx);

  if (id !== undefined) {
    // With an explicit --id the project is only context (e.g. default output
    // paths); a broken project spec must not block addressing a runtime
    // directly.
    const project = await core.projectManager.resolve({ filePath: cwd }).catch(() => undefined);
    return { runtimeId: id, options, project };
  }

  const project = await core.projectManager.resolve({ filePath: cwd });
  if (!project) {
    throw new InputValidationError(
      "required option '--id <id>' not specified " +
        "(run inside an AgentCore project to resolve the deployed runtime automatically)",
      { exitCode: ExitCode.USAGE },
    );
  }

  const deployed = await core.projectManager.resolveDeployedResources(project, {
    target: DEFAULT_TARGET_NAME,
  });
  const runtimes = deployed.resources.filter(({ resourceType }) => resourceType === "runtime");
  if (runtimes.length === 0) {
    throw new ResourceNotFoundError(
      `Project '${project.name}' has no Runtime deployed to target '${DEFAULT_TARGET_NAME}'. ` +
        "Deploy a Runtime first, or pass --id <runtimeId>.",
    );
  }
  if (runtimes.length > 1) {
    throw new InputValidationError(
      `Project '${project.name}' has multiple deployed Runtimes; choose one with ` +
        `--id: ${runtimes.map(({ id: runtimeId }) => runtimeId).join(", ")}`,
    );
  }
  return {
    runtimeId: runtimes[0]!.id,
    options: { ...options, region: deployed.target.region },
    project,
  };
}
