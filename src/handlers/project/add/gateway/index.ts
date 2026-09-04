import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import { GatewayAuthorizerConfigSchema } from "../../../../projectSchemas/auth";
import type { AgentCoreGateway } from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonFlagWithSchema, parseTags } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";

const GatewayAuthorizerConfigurationInputSchema = GatewayAuthorizerConfigSchema.strict();

/**
 The deployed service name of a gateway; mirrors the L3 Gateway construct's rule.
**/
export function gatewayResourceName(
  projectName: string,
  gateway: { name: string; resourceName?: string },
): string {
  return gateway.resourceName ?? `${projectName}-${gateway.name}`;
}

export const createAddGatewayHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway",
    description: "add a Gateway to the current project",
    flags: [
      flag("name", "the Gateway name", z.string().optional()),
      flag(
        "role-arn",
        "IAM role the Gateway assumes; a default role is created when omitted",
        z.string().optional(),
      ),
      flag("protocol-type", "restrict the Gateway to MCP Targets", z.enum(["MCP"]).optional()),
      flag(
        "enable-semantic-search",
        "enable semantic search for tools on the Gateway",
        z.boolean().optional(),
      ),
      flag(
        "authorizer-type",
        "inbound authorizer: AWS_IAM, CUSTOM_JWT, or NONE",
        z.enum(["AWS_IAM", "CUSTOM_JWT", "NONE"]).optional(),
      ),
      flag("description", "Gateway description", z.string().optional()),
      flag(
        "authorizer-configuration",
        "project authorizerConfiguration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "policy-engine-name",
        "name of a Policy Engine declared in this project",
        z.string().optional(),
      ),
      flag(
        "policy-engine-mode",
        "Policy Engine mode: log-only or enforce",
        z.enum(["log-only", "enforce"]).optional(),
      ),
      flag("exception-level", "exception detail level: debug", z.enum(["debug"]).optional()),
      flag("tags", "tags as repeated key=value or a JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const project = ctx.require(ProjectKey);
      const resourceName = gatewayResourceName(project.name, { name: flags.name });
      if (resourceName.length > 48) {
        throw new InputValidationError(
          `Gateway resource name '${resourceName}' exceeds the service limit of 48 characters`,
        );
      }
      if (
        (flags["policy-engine-name"] === undefined) !==
        (flags["policy-engine-mode"] === undefined)
      ) {
        throw new InputValidationError(
          "--policy-engine-name and --policy-engine-mode must be supplied together",
        );
      }
      if (
        flags["policy-engine-name"] &&
        !project.spec.policyEngines.some((engine) => engine.name === flags["policy-engine-name"])
      ) {
        throw new InputValidationError(
          `policy engine '${flags["policy-engine-name"]}' does not exist in policyEngines[]`,
        );
      }

      const authorizerType = flags["authorizer-type"] ?? "NONE";
      if (authorizerType === "CUSTOM_JWT" && flags["authorizer-configuration"] === undefined) {
        throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
      }
      if (authorizerType !== "CUSTOM_JWT" && flags["authorizer-configuration"] !== undefined) {
        throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
      }
      if (flags["enable-semantic-search"] && flags["protocol-type"] !== "MCP") {
        throw new InputValidationError("--enable-semantic-search requires --protocol-type MCP");
      }
      const source = new SourceResolver({ stdin: config.io.stdin });
      const authorizerConfiguration = parseJsonFlagWithSchema(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
        GatewayAuthorizerConfigurationInputSchema,
      );

      const gateway: AgentCoreGateway = {
        name: flags.name,
        protocolType: flags["protocol-type"] ?? "None",
        authorizerType,
        authorizerConfiguration,
        description: flags.description,
        targets: [],
        enableSemanticSearch: flags["enable-semantic-search"] ?? false,
        exceptionLevel: flags["exception-level"] ? "DEBUG" : "NONE",
        executionRoleArn: flags["role-arn"],
        policyEngineConfiguration:
          flags["policy-engine-name"] && flags["policy-engine-mode"]
            ? {
                policyEngineName: flags["policy-engine-name"],
                mode: flags["policy-engine-mode"] === "enforce" ? "ENFORCE" : "LOG_ONLY",
              }
            : undefined,
        tags: parseTags(flags.tags),
      };

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "gateway",
          resourceConfig: gateway,
        },
        `added Gateway '${flags.name}' to '${project.name}'`,
      );
    },
  });
