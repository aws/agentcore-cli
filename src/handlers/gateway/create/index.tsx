import type {
  AuthorizerConfiguration,
  GatewayInterceptorConfiguration,
  GatewayProtocolConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx, parseJsonArrayFlag, parseJsonObjectFlag, parseTags } from "../../utils";
import { validateGatewayCreateInput } from "../mutations";
import type { CreateGatewayInput } from "../types";

export const createCreateGatewayHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create an AgentCore Gateway",
    flags: [
      flag("name", "the Gateway name", z.string().optional()),
      flag(
        "role-arn",
        "IAM role the Gateway assumes; a least-privilege role is created when omitted",
        z.string().optional(),
      ),
      flag(
        "protocol",
        "Gateway protocol: mcp or http (default: http)",
        z.enum(["mcp", "http"]).optional(),
      ),
      flag(
        "authorizer-type",
        "inbound authorizer: AWS_IAM, CUSTOM_JWT, NONE, or AUTHENTICATE_ONLY",
        z.enum(["AWS_IAM", "CUSTOM_JWT", "NONE", "AUTHENTICATE_ONLY"]).optional(),
      ),
      flag("description", "Gateway description", z.string().optional()),
      flag(
        "protocol-configuration",
        "protocol configuration (JSON GatewayProtocolConfiguration)",
        z.string().optional(),
      ),
      flag(
        "authorizer-configuration",
        "authorizer configuration (JSON AuthorizerConfiguration)",
        z.string().optional(),
      ),
      flag("kms-key-arn", "KMS key ARN", z.string().optional()),
      flag(
        "interceptor-configurations",
        "interceptor configurations (JSON GatewayInterceptorConfiguration[])",
        z.string().optional(),
      ),
      flag("policy-engine-arn", "Policy Engine ARN", z.string().optional()),
      flag(
        "policy-engine-mode",
        "Policy Engine mode: log-only or enforce",
        z.enum(["log-only", "enforce"]).optional(),
      ),
      flag("exception-level", "exception detail level: debug", z.enum(["debug"]).optional()),
      flag(
        "tags",
        "tags as key=value (repeatable) or a JSON object",
        z.array(z.string()).optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["authorizer-type"]) {
        throw new InputValidationError(
          "required option '--authorizer-type <authorizer-type>' not specified",
        );
      }
      if (
        (flags["policy-engine-arn"] === undefined) !==
        (flags["policy-engine-mode"] === undefined)
      ) {
        throw new InputValidationError(
          "--policy-engine-arn and --policy-engine-mode must be supplied together",
        );
      }

      const protocolConfiguration = parseJsonObjectFlag<GatewayProtocolConfiguration>(
        "protocol-configuration",
        flags["protocol-configuration"],
      );
      const authorizerConfiguration = parseJsonObjectFlag<AuthorizerConfiguration>(
        "authorizer-configuration",
        flags["authorizer-configuration"],
      );
      const interceptorConfigurations = parseJsonArrayFlag<GatewayInterceptorConfiguration>(
        "interceptor-configurations",
        flags["interceptor-configurations"],
      );
      const policyEngineConfiguration =
        flags["policy-engine-arn"] && flags["policy-engine-mode"]
          ? {
              arn: flags["policy-engine-arn"],
              mode:
                flags["policy-engine-mode"] === "enforce"
                  ? ("ENFORCE" as const)
                  : ("LOG_ONLY" as const),
            }
          : undefined;
      const tags = parseTags(flags.tags);

      const input: CreateGatewayInput = {
        name: flags.name,
        ...(flags["role-arn"] ? { roleArn: flags["role-arn"] } : {}),
        protocol: flags.protocol ?? "http",
        authorizerType: flags["authorizer-type"],
        ...(flags.description ? { description: flags.description } : {}),
        ...(protocolConfiguration ? { protocolConfiguration } : {}),
        ...(authorizerConfiguration ? { authorizerConfiguration } : {}),
        ...(flags["kms-key-arn"] ? { kmsKeyArn: flags["kms-key-arn"] } : {}),
        ...(interceptorConfigurations ? { interceptorConfigurations } : {}),
        ...(policyEngineConfiguration ? { policyEngineConfiguration } : {}),
        ...(flags["exception-level"] ? { exceptionLevel: "DEBUG" as const } : {}),
        ...(tags ? { tags } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      validateGatewayCreateInput(input);
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.createGateway(input, coreOptsFromCtx(ctx)));
    },
  });
