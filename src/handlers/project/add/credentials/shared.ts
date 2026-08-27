import { ProjectKey, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { CLIENT_SECRET_SUFFIX, credentialEnvVarName } from "../../../../core/project/envLocal";
import type { Credential } from "../../../../projectSchemas/credential";
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

  // A credential's secret goes into a per-type .env.local variable (API keys use
  // the base name; OAuth appends _CLIENT_SECRET), so two credentials of different
  // types or hyphen/underscore spellings can collide on one variable and silently
  // share a secret. Reject that on the final key before writing the spec.
  const newName = input.resourceConfig.name;
  const newKeys = new Set((input.envEntries ?? []).map((entry) => entry.key));
  const clash = project.spec.credentials.find((existing) => {
    if (existing.name === newName) return false;
    const key = credentialSecretEnvKey(existing);
    return key !== undefined && newKeys.has(key);
  });
  if (clash) {
    throw new InputValidationError(
      `credential '${newName}' would store its secret in the same .env.local variable as ` +
        `'${clash.name}'; choose a name that does not collide.`,
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

/** The .env.local variable a credential's secret is written to, or undefined when it lives elsewhere (an external ref, or no secret). */
export function credentialSecretEnvKey(credential: Credential): string | undefined {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return credential.secretRef ? undefined : credentialEnvVarName(credential.name);
    case "OAuthCredentialProvider":
      return credential.clientSecretRef
        ? undefined
        : credentialEnvVarName(credential.name, CLIENT_SECRET_SUFFIX);
    case "PaymentCredentialProvider":
      return undefined;
  }
}
