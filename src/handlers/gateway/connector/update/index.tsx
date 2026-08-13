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
import {
  assertMutuallyExclusiveInputs,
  coreOptsFromCtx,
  parseJsonArrayFlag,
  parseJsonObjectFlag,
} from "../../../utils";
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
      assertMutuallyExclusiveInputs([
        ["connector", flags.connector, "connector-configuration", flags["connector-configuration"]],
        [
          "description",
          flags.description,
          "clear-description",
          flags["clear-description"] || undefined,
        ],
        [
          "credential-provider-configurations",
          flags["credential-provider-configurations"],
          "clear-credential-provider-configurations",
          flags["clear-credential-provider-configurations"] || undefined,
        ],
        [
          "metadata-configuration",
          flags["metadata-configuration"],
          "clear-metadata-configuration",
          flags["clear-metadata-configuration"] || undefined,
        ],
        [
          "private-endpoint",
          flags["private-endpoint"],
          "clear-private-endpoint",
          flags["clear-private-endpoint"] || undefined,
        ],
      ]);
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

      const mutations: Omit<GatewayTargetUpdatePatch, "gatewayId" | "targetId"> = {
        name: flags.name,
        description: flags["clear-description"] ? null : flags.description,
        targetConfiguration,
        credentialProviderConfigurations: flags["clear-credential-provider-configurations"]
          ? null
          : credentialProviderConfigurations,
        metadataConfiguration: flags["clear-metadata-configuration"] ? null : metadataConfiguration,
        privateEndpoint: flags["clear-private-endpoint"] ? null : privateEndpoint,
      };
      if (Object.values(mutations).every((value) => value === undefined)) {
        throw new InputValidationError("Connector update requires at least one mutation option");
      }
      const patch: GatewayTargetUpdatePatch = {
        gatewayId: flags["gateway-id"],
        targetId: flags.id,
        ...mutations,
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.updateGatewayConnector(patch, coreOptsFromCtx(ctx)));
    },
  });
