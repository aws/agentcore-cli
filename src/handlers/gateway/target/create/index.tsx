import type {
  CredentialProviderConfiguration,
  McpToolSchemaConfiguration,
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
import { validateGatewayTargetCreateInput } from "../../mutations";
import type { CreateGatewayTargetInput } from "../../types";

export const createCreateGatewayTargetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag(
        "name",
        "Target name; optional only for AgentCore Runtime Targets",
        z.string().optional(),
      ),
      flag("description", "Target description", z.string().optional()),
      flag("endpoint", "MCP server HTTPS endpoint", z.string().optional()),
      flag(
        "target-configuration",
        "complete Target configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("tool-schema", "MCP tool schema source", z.string().optional()),
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
      if ((flags.endpoint === undefined) === (flags["target-configuration"] === undefined)) {
        throw new InputValidationError(
          "specify exactly one of '--endpoint' or '--target-configuration'",
        );
      }
      if (flags["tool-schema"] !== undefined && flags.endpoint === undefined) {
        throw new InputValidationError("--tool-schema requires --endpoint");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const exactConfiguration = parseJsonObjectFlag<TargetConfiguration>(
        "target-configuration",
        await source.resolveText("target-configuration", flags["target-configuration"]),
      );
      const toolSchemaSource = flags["tool-schema"];
      let mcpToolSchema: McpToolSchemaConfiguration | undefined;
      if (toolSchemaSource !== undefined) {
        mcpToolSchema = toolSchemaSource.startsWith("s3://")
          ? { s3: { uri: toolSchemaSource } }
          : {
              inlinePayload: (await source.resolveText("tool-schema", toolSchemaSource))!,
            };
      }
      const targetConfiguration: TargetConfiguration = exactConfiguration ?? {
        mcp: {
          mcpServer: {
            endpoint: flags.endpoint!,
            ...(mcpToolSchema ? { mcpToolSchema } : {}),
          },
        },
      };
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
        targetConfiguration,
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.description ? { description: flags.description } : {}),
        ...(credentialProviderConfigurations ? { credentialProviderConfigurations } : {}),
        ...(metadataConfiguration ? { metadataConfiguration } : {}),
        ...(privateEndpoint ? { privateEndpoint } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.gateway.createGatewayTarget(
            validateGatewayTargetCreateInput(input),
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
