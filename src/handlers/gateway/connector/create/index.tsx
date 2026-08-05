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
import type { CreateGatewayTargetInput } from "../../types";
import { GatewayConnectorTarget } from "../target";

export const createCreateGatewayConnectorHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a connector-backed Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("name", "Connector Target name", z.string().optional()),
      flag("description", "Connector Target description", z.string().optional()),
      flag(
        "connector-configuration",
        "connector-backed Target configuration (JSON; inline, file://<path>, or - for stdin)",
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
        "outbound credentials (JSON array; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "metadata-configuration",
        "metadata propagation (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "private-endpoint",
        "private endpoint (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if ((flags.connector === undefined) === (flags["connector-configuration"] === undefined)) {
        throw new InputValidationError(
          "specify exactly one of '--connector' or '--connector-configuration'",
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

      const source = new SourceResolver({ stdin: io.stdin });
      const exactConfiguration = parseJsonObjectFlag<TargetConfiguration>(
        "connector-configuration",
        await source.resolveText("connector-configuration", flags["connector-configuration"]),
      );
      const targetConfiguration =
        exactConfiguration ??
        GatewayConnectorTarget.fromShortcut(flags.connector!, flags["knowledge-base-id"]);
      if (!GatewayConnectorTarget.is(targetConfiguration)) {
        throw new InputValidationError(
          "--connector-configuration must contain an MCP or inference connector Target",
        );
      }

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
      const input: CreateGatewayTargetInput = {
        gatewayIdentifier: flags["gateway-id"],
        name: flags.name,
        targetConfiguration,
        ...(flags.description ? { description: flags.description } : {}),
        ...(credentialProviderConfigurations ? { credentialProviderConfigurations } : {}),
        ...(metadataConfiguration ? { metadataConfiguration } : {}),
        ...(privateEndpoint ? { privateEndpoint } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.createGatewayTarget(input, coreOptsFromCtx(ctx)));
    },
  });
