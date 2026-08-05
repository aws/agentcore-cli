import type {
  CredentialProviderConfiguration,
  MetadataConfiguration,
  PrivateEndpoint,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonArrayFlag, parseJsonObjectFlag } from "../../../utils";
import { validateGatewayTargetCreateInput } from "../../mutations";
import type { CreateGatewayTargetInput } from "../../types";

export const createCreateGatewayTargetHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create a Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag(
        "name",
        "Target name (optional only for an exact Runtime Target)",
        z.string().optional(),
      ),
      flag("description", "Target description", z.string().optional()),
      flag("type", "guided Target type: mcp-server", z.enum(["mcp-server"]).optional()),
      flag("endpoint", "MCP server HTTPS endpoint", z.string().optional()),
      flag(
        "target-configuration",
        "complete Target configuration (JSON TargetConfiguration)",
        z.string().optional(),
      ),
      flag(
        "credential-provider-configurations",
        "outbound credentials (JSON CredentialProviderConfiguration[])",
        z.string().optional(),
      ),
      flag(
        "metadata-configuration",
        "metadata propagation (JSON MetadataConfiguration)",
        z.string().optional(),
      ),
      flag("private-endpoint", "private endpoint (JSON PrivateEndpoint)", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }

      const hasGuidedInput = flags.type !== undefined || flags.endpoint !== undefined;
      if (flags["target-configuration"] !== undefined && hasGuidedInput) {
        throw new InputValidationError(
          "--target-configuration is mutually exclusive with --type and --endpoint",
        );
      }
      if (flags.type !== undefined && flags.endpoint === undefined) {
        throw new InputValidationError("--type mcp-server requires --endpoint");
      }
      if (flags.endpoint !== undefined && flags.type === undefined) {
        throw new InputValidationError("--endpoint requires --type mcp-server");
      }
      if (!hasGuidedInput && flags["target-configuration"] === undefined) {
        throw new InputValidationError(
          "either --type mcp-server with --endpoint or --target-configuration is required",
        );
      }

      const exactConfiguration = parseJsonObjectFlag<TargetConfiguration>(
        "target-configuration",
        flags["target-configuration"],
      );
      const targetConfiguration: TargetConfiguration =
        exactConfiguration ??
        ({
          mcp: {
            mcpServer: {
              endpoint: flags.endpoint!,
            },
          },
        } as TargetConfiguration);
      const credentialProviderConfigurations = parseJsonArrayFlag<CredentialProviderConfiguration>(
        "credential-provider-configurations",
        flags["credential-provider-configurations"],
      );
      const metadataConfiguration = parseJsonObjectFlag<MetadataConfiguration>(
        "metadata-configuration",
        flags["metadata-configuration"],
      );
      const privateEndpoint = parseJsonObjectFlag<PrivateEndpoint>(
        "private-endpoint",
        flags["private-endpoint"],
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

      validateGatewayTargetCreateInput(input);
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.createGatewayTarget(input, coreOptsFromCtx(ctx)));
    },
  });
