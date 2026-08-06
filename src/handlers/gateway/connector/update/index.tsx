import type {
  CredentialProviderConfiguration,
  MetadataConfiguration,
  PrivateEndpoint,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonArrayFlag, parseJsonObjectFlag } from "../../../utils";
import type { GatewayTargetUpdatePatch } from "../../types";
import { GatewayConnectorTarget } from "../gatewayConnectorTarget";

export const createUpdateGatewayConnectorHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a connector-backed Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("id", "the connector-backed Gateway Target ID", z.string().optional()),
      flag("name", "updated Connector Target name", z.string().optional()),
      flag("description", "updated Connector Target description", z.string().optional()),
      flag(
        "connector-configuration",
        "complete connector-backed Target configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "connector",
        "curated connector",
        z.enum(["web-search", "bedrock-knowledge-bases", "bedrock-mantle"]).optional(),
      ),
      flag(
        "knowledge-base-id",
        "Knowledge Base ID for the bedrock-knowledge-bases connector",
        z.string().optional(),
      ),
      flag(
        "credential-provider-configurations",
        "replacement outbound credentials (JSON array; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "metadata-configuration",
        "replacement metadata propagation (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "private-endpoint",
        "replacement private endpoint (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("clear-description", "remove the Connector Target description", z.boolean()),
      flag("clear-credential-provider-configurations", "remove outbound credentials", z.boolean()),
      flag("clear-metadata-configuration", "remove metadata propagation", z.boolean()),
      flag("clear-private-endpoint", "remove private endpoint configuration", z.boolean()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (flags.connector !== undefined && flags["connector-configuration"] !== undefined) {
        throw new InputValidationError(
          "--connector and --connector-configuration are mutually exclusive",
        );
      }
      if (
        flags.connector === "bedrock-knowledge-bases" &&
        flags["knowledge-base-id"] === undefined
      ) {
        throw new InputValidationError(
          "--connector bedrock-knowledge-bases requires --knowledge-base-id",
        );
      }
      if (
        flags["knowledge-base-id"] !== undefined &&
        flags.connector !== "bedrock-knowledge-bases"
      ) {
        throw new InputValidationError(
          "--knowledge-base-id requires --connector bedrock-knowledge-bases",
        );
      }

      for (const [name, value, clear] of [
        ["description", flags.description, flags["clear-description"]],
        [
          "credential-provider-configurations",
          flags["credential-provider-configurations"],
          flags["clear-credential-provider-configurations"],
        ],
        [
          "metadata-configuration",
          flags["metadata-configuration"],
          flags["clear-metadata-configuration"],
        ],
        ["private-endpoint", flags["private-endpoint"], flags["clear-private-endpoint"]],
      ] as const) {
        if (value !== undefined && clear) {
          throw new InputValidationError(`--${name} and --clear-${name} are mutually exclusive`);
        }
      }

      const hasMutation =
        flags.name !== undefined ||
        flags.description !== undefined ||
        flags["clear-description"] ||
        flags.connector !== undefined ||
        flags["connector-configuration"] !== undefined ||
        flags["credential-provider-configurations"] !== undefined ||
        flags["clear-credential-provider-configurations"] ||
        flags["metadata-configuration"] !== undefined ||
        flags["clear-metadata-configuration"] ||
        flags["private-endpoint"] !== undefined ||
        flags["clear-private-endpoint"];
      if (!hasMutation) {
        throw new InputValidationError("Connector update requires at least one mutation option");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const exactConfiguration = parseJsonObjectFlag<TargetConfiguration>(
        "connector-configuration",
        await source.resolveText("connector-configuration", flags["connector-configuration"]),
      );
      if (exactConfiguration && !GatewayConnectorTarget.is(exactConfiguration)) {
        throw new InputValidationError(
          "--connector-configuration must contain an MCP or inference connector Target",
        );
      }
      const targetConfiguration =
        exactConfiguration ??
        (flags.connector
          ? GatewayConnectorTarget.fromShortcut(flags.connector, flags["knowledge-base-id"])
          : undefined);
      const credentialProviderConfigurations = parseJsonArrayFlag<CredentialProviderConfiguration>(
        "credential-provider-configurations",
        await source.resolveText(
          "credential-provider-configurations",
          flags["credential-provider-configurations"],
        ),
      );
      const metadataConfiguration = parseJsonObjectFlag<MetadataConfiguration>(
        "metadata-configuration",
        await source.resolveText("metadata-configuration", flags["metadata-configuration"]),
      );
      const privateEndpoint = parseJsonObjectFlag<PrivateEndpoint>(
        "private-endpoint",
        await source.resolveText("private-endpoint", flags["private-endpoint"]),
      );

      const patch: GatewayTargetUpdatePatch = {
        gatewayId: flags["gateway-id"],
        targetId: flags.id,
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags["clear-description"]
          ? { description: null }
          : flags.description !== undefined
            ? { description: flags.description }
            : {}),
        ...(targetConfiguration !== undefined ? { targetConfiguration } : {}),
        ...(flags["clear-credential-provider-configurations"]
          ? { credentialProviderConfigurations: null }
          : credentialProviderConfigurations !== undefined
            ? { credentialProviderConfigurations }
            : {}),
        ...(flags["clear-metadata-configuration"]
          ? { metadataConfiguration: null }
          : metadataConfiguration !== undefined
            ? { metadataConfiguration }
            : {}),
        ...(flags["clear-private-endpoint"]
          ? { privateEndpoint: null }
          : privateEndpoint !== undefined
            ? { privateEndpoint }
            : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.updateGatewayConnector(patch, coreOptsFromCtx(ctx)));
    },
  });
