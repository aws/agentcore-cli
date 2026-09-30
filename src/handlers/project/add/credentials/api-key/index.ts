import z from "zod";
import type { SecretReference } from "../../../../../projectSchemas/credential";
import { createHandler, flag } from "../../../../../router";
import { SourceResolver } from "../../../../../io";
import type { AddProjectResourceConfig } from "../../types";
import type { EnvLocalEntry } from "../../../types";
import {
  addCredentialToProject,
  credentialEnvVarName,
  parseExclusiveSecretRef,
  type AddCredentialInput,
} from "../shared";

export type ApiKeyCredentialInput = {
  name: string;
  apiKey?: string;
  secretRef?: SecretReference;
};

export function toAddApiKeyCredentialInput(input: ApiKeyCredentialInput): AddCredentialInput {
  const envEntries: EnvLocalEntry[] = input.secretRef
    ? []
    : [
        {
          key: credentialEnvVarName(input.name),
          value: input.apiKey,
          comment: `API key for credential provider '${input.name}' (set before deploy)`,
        },
      ];

  return {
    resourceConfig: {
      authorizerType: "ApiKeyCredentialProvider",
      name: input.name,
      secretRef: input.secretRef,
    },
    envEntries,
  };
}

export const createAddApiKeyCredentialHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "api-key",
    description: "add an API key credential provider to the current project",
    flags: [
      flag("name", "the name of the credential provider", z.string().min(1)),
      flag(
        "api-key",
        "the API key (file://path or - for stdin; inline values are rejected)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const secretRef = parseExclusiveSecretRef(
        "api-key-secret-reference",
        flags["api-key-secret-reference"],
        "api-key",
        flags["api-key"],
      );

      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await resolver.resolveSecret("api-key", flags["api-key"]);

      await addCredentialToProject(
        ctx,
        config,
        toAddApiKeyCredentialInput({ name: flags.name, apiKey, secretRef }),
      );
    },
  });
