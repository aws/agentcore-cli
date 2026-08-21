import { ProjectKey, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../../identity/parser";
import type { AddProjectResourceConfig } from "../types";
import type { AddResourceInput } from "../../types";

/** Derives the .env.local variable name a credential's secret is stored under. */
export function credentialEnvVarName(credentialName: string, suffix = ""): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, "_").toUpperCase()}${suffix}`;
}

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

/**
 * Resolves a secret flag while refusing inline values: an inline secret leaks
 * into shell history and process listings, so only stdin and files are allowed.
 * A single trailing newline is stripped (echo and editors add one).
 */
export async function resolveSecretFlag(
  resolver: SourceResolver,
  name: string,
  source: string | undefined,
): Promise<string | undefined> {
  if (source !== undefined && source !== "-" && !source.startsWith("file://")) {
    throw new InputValidationError(
      `--${name} must come from stdin ('-') or a file ('file://<path>'); ` +
        "inline secret values are not accepted",
    );
  }
  const value = await resolver.resolveText(name, source);
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r?\n$/, "");
  if (normalized.includes("\n")) {
    throw new InputValidationError(`--${name} must be a single-line value`);
  }
  return normalized;
}

/** Runs the shared add flow: spec update, env entries, progress, and fill-before-deploy notice. */
export async function addCredentialToProject(
  ctx: Context,
  config: AddProjectResourceConfig,
  input: Omit<Extract<AddResourceInput, { resourceType: "credential" }>, "resourceType">,
): Promise<void> {
  const project = ctx.require(ProjectKey);
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
