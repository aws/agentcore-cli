import { InputValidationError } from "../../errors";
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
 * one the enclosing project's deployed runtime is resolved live from its
 * CloudFormation stack outputs (default target). Outside a project, --id is
 * required.
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

  const deployed = await core.observability.resolveDeployedRuntime(project, DEFAULT_TARGET_NAME);
  return {
    runtimeId: deployed.runtimeId,
    options: { ...options, region: deployed.region },
    project,
  };
}
