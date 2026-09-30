import { ProjectKey, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { parseSecretReference } from "../../../identity/parser";
import type { AddProjectResourceConfig } from "../types";
import type { AddResourceInput, Project } from "../../types";
import {
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
  credentialNameFieldSuffix,
} from "../../../../projectSchemas/credential";
import { addProjectResource } from "../shared";

export { credentialEnvVarName };

export type AddCredentialInput = Omit<
  Extract<AddResourceInput, { resourceType: "credential" }>,
  "resourceType"
>;

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

/** Applies credential-specific name and environment-variable collision checks. */
export function toAddCredentialInput(
  project: Project,
  input: AddCredentialInput,
): Extract<AddResourceInput, { resourceType: "credential" }> {
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

  // The collision check above only compares the fields credentials write today. A name
  // ending in a field suffix would also shadow a field the CLI no longer writes but
  // still reads — an OAuth client id, which now lives in agentcore.json but is still
  // read from .env.local for projects created before it moved — or one a later
  // credential adds. Such a name is refused outright rather than when something
  // clashes; see CREDENTIAL_FIELD_SUFFIXES for the full list and why each is there.
  const fieldSuffix = credentialNameFieldSuffix(newName);
  if (fieldSuffix) {
    throw new InputValidationError(
      `credential '${newName}' derives the environment variable ` +
        `${credentialEnvVarName(newName)}, which ends in '${fieldSuffix}' — the suffix the CLI ` +
        `appends to name one of a credential's own fields, so the variable would be ` +
        `indistinguishable from that field of another credential. Choose a name that does not ` +
        `end in '${fieldSuffix}' (hyphens count as underscores).`,
    );
  }

  return {
    resourceType: "credential",
    ...input,
  };
}

export function credentialSetupNotes(input: AddCredentialInput): string[] {
  return (input.envEntries ?? [])
    .filter((entry) => entry.value === undefined)
    .map((entry) => `Set ${entry.key} in agentcore/.env.local before you deploy.`);
}

/** Runs the shared add flow: spec update, env entries, progress, and fill-before-deploy notice. */
export async function addCredentialToProject(
  ctx: Context,
  config: AddProjectResourceConfig,
  input: AddCredentialInput,
): Promise<void> {
  const project = ctx.require(ProjectKey);

  await addProjectResource(
    ctx,
    config,
    project,
    toAddCredentialInput(project, input),
    `added credential '${input.resourceConfig.name}' to '${project.name}'`,
    { notes: credentialSetupNotes(input) },
  );
}
