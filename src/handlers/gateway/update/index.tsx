import type {
  AuthorizerConfiguration,
  CustomTransformConfiguration,
  GatewayInterceptorConfiguration,
  GatewayProtocolConfiguration,
  WafConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../errors";
import { type AppIO, SourceResolver } from "../../../io";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import {
  coreOptsFromCtx,
  parseJsonArrayFlag,
  parseJsonObjectFlag,
  validateSetClearConflicts,
} from "../../utils";
import type { GatewayUpdatePatch } from "../types";

export const createUpdateGatewayHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an AgentCore Gateway",
    flags: [
      flag("id", "the Gateway ID", z.string().optional()),
      flag("role-arn", "updated IAM role ARN", z.string().optional()),
      flag("description", "updated Gateway description", z.string().optional()),
      flag(
        "protocol-configuration",
        "replacement MCP protocol configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "authorizer-configuration",
        "replacement CUSTOM_JWT configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "custom-transform-configuration",
        "replacement custom transform configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "interceptor-configurations",
        "replacement interceptors (JSON array; inline, file://<path>, or - for stdin)",
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
        "waf-configuration",
        "replacement WAF configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("clear-protocol", "remove the MCP-only Target restriction", z.boolean()),
      flag("clear-description", "remove the Gateway description", z.boolean()),
      flag("clear-protocol-configuration", "remove MCP protocol overrides", z.boolean()),
      flag(
        "clear-custom-transform-configuration",
        "remove the custom transform configuration",
        z.boolean(),
      ),
      flag("clear-interceptor-configurations", "remove every interceptor", z.boolean()),
      flag("clear-policy-engine", "detach the Policy Engine", z.boolean()),
      flag("clear-exception-level", "return to generic invocation errors", z.boolean()),
      flag("clear-waf-configuration", "reset WAF failure mode to FAIL_CLOSE", z.boolean()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      validateSetClearConflicts([
        ["description", flags.description, flags["clear-description"]],
        [
          "protocol-configuration",
          flags["protocol-configuration"],
          flags["clear-protocol-configuration"],
        ],
        [
          "custom-transform-configuration",
          flags["custom-transform-configuration"],
          flags["clear-custom-transform-configuration"],
        ],
        [
          "interceptor-configurations",
          flags["interceptor-configurations"],
          flags["clear-interceptor-configurations"],
        ],
        ["exception-level", flags["exception-level"], flags["clear-exception-level"]],
        ["waf-configuration", flags["waf-configuration"], flags["clear-waf-configuration"]],
      ]);
      if (
        flags["clear-policy-engine"] &&
        (flags["policy-engine-arn"] !== undefined || flags["policy-engine-mode"] !== undefined)
      ) {
        throw new InputValidationError(
          "--clear-policy-engine conflicts with --policy-engine-arn and --policy-engine-mode",
        );
      }
      if (flags["policy-engine-arn"] && !flags["policy-engine-mode"]) {
        throw new InputValidationError("--policy-engine-arn requires --policy-engine-mode");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const protocolConfiguration = parseJsonObjectFlag<GatewayProtocolConfiguration>(
        "protocol-configuration",
        await source.resolveText("protocol-configuration", flags["protocol-configuration"]),
      );
      const authorizerConfiguration = parseJsonObjectFlag<AuthorizerConfiguration>(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
      );
      const customTransformConfiguration = parseJsonObjectFlag<CustomTransformConfiguration>(
        "custom-transform-configuration",
        await source.resolveText(
          "custom-transform-configuration",
          flags["custom-transform-configuration"],
        ),
      );
      const interceptorConfigurations = parseJsonArrayFlag<GatewayInterceptorConfiguration>(
        "interceptor-configurations",
        await source.resolveText("interceptor-configurations", flags["interceptor-configurations"]),
      );
      const wafConfiguration = parseJsonObjectFlag<WafConfiguration>(
        "waf-configuration",
        await source.resolveText("waf-configuration", flags["waf-configuration"]),
      );

      const mutations: Omit<GatewayUpdatePatch, "id"> = {
        roleArn: flags["role-arn"],
        clearProtocol: flags["clear-protocol"] || undefined,
        description: flags["clear-description"] ? null : flags.description,
        protocolConfiguration: flags["clear-protocol-configuration"] ? null : protocolConfiguration,
        authorizerConfiguration,
        customTransformConfiguration: flags["clear-custom-transform-configuration"]
          ? null
          : customTransformConfiguration,
        interceptorConfigurations: flags["clear-interceptor-configurations"]
          ? null
          : interceptorConfigurations,
        policyEngineConfiguration: flags["clear-policy-engine"]
          ? null
          : flags["policy-engine-arn"] !== undefined || flags["policy-engine-mode"] !== undefined
            ? {
                arn: flags["policy-engine-arn"],
                mode:
                  flags["policy-engine-mode"] === undefined
                    ? undefined
                    : flags["policy-engine-mode"] === "enforce"
                      ? "ENFORCE"
                      : "LOG_ONLY",
              }
            : undefined,
        exceptionLevel: flags["clear-exception-level"]
          ? null
          : flags["exception-level"]
            ? "DEBUG"
            : undefined,
        wafConfiguration: flags["clear-waf-configuration"] ? null : wafConfiguration,
      };
      if (Object.values(mutations).every((value) => value === undefined)) {
        throw new InputValidationError("Gateway update requires at least one mutation option");
      }
      const patch: GatewayUpdatePatch = { id: flags.id, ...mutations };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.updateGateway(patch, coreOptsFromCtx(ctx)));
    },
  });
