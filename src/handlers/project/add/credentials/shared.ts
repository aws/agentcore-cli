import { ProjectKey, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { CLIENT_SECRET_SUFFIX, credentialEnvVarName } from "../../../../core/project/envLocal";
import { parseSecretReference } from "../../../identity/parser";
import type { AddProjectResourceConfig } from "../types";
import type { AddResourceInput } from "../../types";

// Re-exported so the add handlers and `project deploy` derive secret variable
// names from one definition: deploy reads back exactly what add writes.
export { CLIENT_SECRET_SUFFIX, credentialEnvVarName };

/** Parses a secret-reference flag, rejecting a directly supplied secret alongside it. */
export function parseExclusiveSecretRef(
  refFlag: string,
  refValue: string | undefined,
  secretFlag: string,
  secretValue: string | undefined,
) {
  if (!refValue) return undefined;
  if (secretValue !== undefined) {
    throw new InputValidationError(`--${secretFlag} and --${refFlag} are mutually exclusive`);
  }
  return parseSecretReference(refFlag, refValue);
}

/** Runs the shared add flow: spec update, env entries, progress, and fill-before-deploy notice. */
export async function addCredentialToProject(
  ctx: Context,
  config: AddProjectResourceConfig,
  input: Omit<Extract<AddResourceInput, { resourceType: "credential" }>, "resourceType">,
): Promise<void> {
  const project = ctx.require(ProjectKey);

  // Two names that differ only by '-' vs '_' derive the same environment
  // variable, which would silently reuse one secret for both providers.
  const newName = input.resourceConfig.name;
  const clash = project.spec.credentials.find(
    (existing) =>
      existing.name !== newName &&
      credentialEnvVarName(existing.name) === credentialEnvVarName(newName),
  );
  if (clash) {
    throw new InputValidationError(
      `credential '${newName}' and '${clash.name}' derive the same environment variable name; ` +
        "choose a name that differs by more than '-' and '_'",
    );
  }

  for await (const event of config.projectManager.addResource(project, {
    resourceType: "credential",
    ...input,
  })) {
    config.io.stderr.write(`${event.message}\n`);
  }

  config.io.stderr.write(`added credential '${input.resourceConfig.name}' to '${project.name}'\n`);
  for (const entry of (input.envEntries ?? []).filter((e) => e.value === undefined)) {
    config.io.stderr.write(`Set ${entry.key} in agentcore/.env.local before you deploy.\n`);
  }
}
