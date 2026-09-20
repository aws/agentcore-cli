import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { SourceResolver } from "../../../../../io";
import type { AddProjectResourceConfig } from "../../types";
import type { EnvLocalEntry } from "../../../types";
import { addCredentialToProject, credentialEnvVarName, parseExclusiveSecretRef } from "../shared";

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

      const envEntries: EnvLocalEntry[] = secretRef
        ? []
        : [
            {
              key: credentialEnvVarName(flags.name),
              value: apiKey,
              comment: `API key for credential provider '${flags.name}' (set before deploy)`,
            },
          ];

      await addCredentialToProject(ctx, config, {
        resourceConfig: { authorizerType: "ApiKeyCredentialProvider", name: flags.name, secretRef },
        envEntries,
      });
    },
  });
