import { ProjectKey, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { parseSecretReference } from "../../../identity/parser";
import type { AddProjectResourceConfig } from "../types";
import type { AddResourceInput } from "../../types";
import {
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
} from "../../../../projectSchemas/credential";

export { credentialEnvVarName };

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

  const newName = input.resourceConfig.name;
  const existingEnvironmentNames = new Map<string, string>();
  for (const credential of project.spec.credentials) {
    for (const environmentName of credentialEnvironmentVariableNames(credential)) {
      existingEnvironmentNames.set(environmentName, credential.name);
    }
  }
  const conflictingEnvironmentName = input.envEntries?.find((entry) =>
    existingEnvironmentNames.has(entry.key),
  )?.key;
  if (conflictingEnvironmentName) {
    const conflictingName = existingEnvironmentNames.get(conflictingEnvironmentName)!;
    throw new InputValidationError(
      `credential '${newName}' and '${conflictingName}' derive the same environment variable ` +
        `'${conflictingEnvironmentName}'; choose credential names that produce distinct environment variables`,
    );
  }

  for await (const event of config.projectManager.addResource(project, {
    resourceType: "credential",
    ...input,
  })) {
    if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
  }

  config.io.stderr.write(`added credential '${input.resourceConfig.name}' to '${project.name}'\n`);
  for (const entry of (input.envEntries ?? []).filter((e) => e.value === undefined)) {
    config.io.stderr.write(`Set ${entry.key} in agentcore/.env.local before you deploy.\n`);
  }
}
