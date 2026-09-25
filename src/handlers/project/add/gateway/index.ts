import z from "zod";
import { InputValidationError, ResourceNotFoundError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  GatewayAuthorizerConfigSchema,
  type GatewayAuthorizerType,
} from "../../../../projectSchemas/auth";
import type {
  AgentCoreGateway,
  GatewayExceptionLevel,
  GatewayProtocolType,
  PolicyEngineMode,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { formatZodError } from "../../../../router/schema";
import { parseJsonFlag, parseTags } from "../../../utils";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits } from "../shared";

export const GatewayAuthorizerConfigurationInputSchema = GatewayAuthorizerConfigSchema.strict();

export interface GatewayInput {
  name: string;
  protocolType?: GatewayProtocolType;
  authorizerType?: GatewayAuthorizerType;
  authorizerConfiguration?: unknown;
  enableSemanticSearch?: boolean;
  description?: string;
  exceptionLevel?: GatewayExceptionLevel;
  executionRoleArn?: string;
  policyEngine?: { name: string; mode: PolicyEngineMode };
  tags?: Record<string, string>;
}

export function toAddGatewayInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: GatewayInput,
): AddResourceInput {
  requireDeployedNameFits("Gateway", project.name, input.name, "-", 100, targets);

  if (
    input.policyEngine &&
    !project.spec.policyEngines.some((engine) => engine.name === input.policyEngine?.name)
  ) {
    throw new ResourceNotFoundError(
      `no policy-engine named '${input.policyEngine.name}' exists in this project`,
    );
  }

  const authorizerType = input.authorizerType ?? "NONE";
  if (authorizerType === "CUSTOM_JWT" && input.authorizerConfiguration === undefined) {
    throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
  }
  if (authorizerType !== "CUSTOM_JWT" && input.authorizerConfiguration !== undefined) {
    throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
  }

  const protocolType = input.protocolType ?? "None";
  if (input.enableSemanticSearch && protocolType !== "MCP") {
    throw new InputValidationError("--enable-semantic-search requires --protocol-type MCP");
  }

  let authorizerConfiguration: AgentCoreGateway["authorizerConfiguration"];
  if (input.authorizerConfiguration !== undefined) {
    const parsed = GatewayAuthorizerConfigurationInputSchema.safeParse(
      input.authorizerConfiguration,
    );
    if (!parsed.success) {
      throw new InputValidationError(
        `Invalid value for option '--authorizer-configuration': ${formatZodError(parsed.error)}`,
        { cause: parsed.error },
      );
    }
    authorizerConfiguration = parsed.data;
  }

  const gateway: AgentCoreGateway = {
    name: input.name,
    protocolType,
    authorizerType,
    authorizerConfiguration,
    description: input.description,
    targets: [],
    enableSemanticSearch: input.enableSemanticSearch ?? false,
    exceptionLevel: input.exceptionLevel ?? "NONE",
    executionRoleArn: input.executionRoleArn,
    policyEngineConfiguration: input.policyEngine
      ? {
          policyEngineName: input.policyEngine.name,
          mode: input.policyEngine.mode,
        }
      : undefined,
    tags: input.tags,
  };

  return { resourceType: "gateway", resourceConfig: gateway };
}

export const createAddGatewayHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway",
    description: "add a Gateway to the current project",
    flags: [
      flag("name", "the Gateway name", z.string().min(1)),
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
      if (
        (flags["policy-engine-name"] === undefined) !==
        (flags["policy-engine-mode"] === undefined)
      ) {
        throw new InputValidationError(
          "--policy-engine-name and --policy-engine-mode must be supplied together",
        );
      }

      const source = new SourceResolver({ stdin: config.io.stdin });
      const authorizerConfiguration = parseJsonFlag<unknown>(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
      );

      const project = ctx.require(ProjectKey);
      const input = toAddGatewayInput(project, await config.projectManager.listTargets(project), {
        name: flags.name,
        protocolType: flags["protocol-type"],
        authorizerType: flags["authorizer-type"],
        authorizerConfiguration,
        description: flags.description,
        enableSemanticSearch: flags["enable-semantic-search"],
        exceptionLevel: flags["exception-level"] ? "DEBUG" : undefined,
        executionRoleArn: flags["role-arn"],
        policyEngine:
          flags["policy-engine-name"] && flags["policy-engine-mode"]
            ? {
                name: flags["policy-engine-name"],
                mode: flags["policy-engine-mode"] === "enforce" ? "ENFORCE" : "LOG_ONLY",
              }
            : undefined,
        tags: parseTags(flags.tags),
      });

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added Gateway '${flags.name}' to '${project.name}'`,
      );
    },
  });
