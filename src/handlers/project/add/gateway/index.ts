import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
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

/**
 * The authorizerConfiguration shape both entry points accept. Strict, so the
 * SDK's casing (`customJWTAuthorizer`) is reported as an unknown key rather than
 * silently dropped and then rejected later as a missing `customJwtAuthorizer`.
 */
export const GatewayAuthorizerConfigurationInputSchema = GatewayAuthorizerConfigSchema.strict();

/** The service limit on a Gateway's deployed name. */
export const MAX_GATEWAY_RESOURCE_NAME_LENGTH = 48;

/**
 The deployed service name of a gateway; mirrors the L3 Gateway construct's rule.
**/
export function gatewayResourceName(
  projectName: string,
  gateway: { name: string; resourceName?: string },
): string {
  return gateway.resourceName ?? `${projectName}-${gateway.name}`;
}

/**
 * GatewayInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before a Gateway is built. Values are already
 * typed: flag text has been read from file/stdin, JSON has been parsed, tags
 * have been split. Anything optional is a field toAddGatewayInput defaults.
 */
export interface GatewayInput {
  name: string;
  protocolType?: GatewayProtocolType;
  authorizerType?: GatewayAuthorizerType;
  /** Parsed JSON; validated against GatewayAuthorizerConfigurationInputSchema here. */
  authorizerConfiguration?: unknown;
  enableSemanticSearch?: boolean;
  description?: string;
  exceptionLevel?: GatewayExceptionLevel;
  executionRoleArn?: string;
  policyEngine?: { name: string; mode: PolicyEngineMode };
  tags?: Record<string, string>;
}

/**
 * toAddGatewayInput is the one place a Gateway is assembled from user input:
 * the defaults for what was not said, the rules that span fields, and the
 * schema the authorizer configuration must satisfy. Both the flag handler and
 * the wizard call it, so they cannot disagree about what a Gateway is.
 */
export function toAddGatewayInput(project: Project, input: GatewayInput): AddResourceInput {
  const resourceName = gatewayResourceName(project.name, { name: input.name });
  if (resourceName.length > MAX_GATEWAY_RESOURCE_NAME_LENGTH) {
    throw new InputValidationError(
      `Gateway resource name '${resourceName}' exceeds the service limit of ` +
        `${MAX_GATEWAY_RESOURCE_NAME_LENGTH} characters`,
    );
  }
  if (
    input.policyEngine &&
    !project.spec.policyEngines.some((engine) => engine.name === input.policyEngine?.name)
  ) {
    throw new InputValidationError(
      `policy engine '${input.policyEngine.name}' does not exist in policyEngines[]`,
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
      ? { policyEngineName: input.policyEngine.name, mode: input.policyEngine.mode }
      : undefined,
    tags: input.tags,
  };
  return { resourceType: "gateway", resourceConfig: gateway };
}

export const createAddGatewayHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway",
    description: "adds a Gateway to the current project",
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
    // handle only turns flags into a GatewayInput — resolving sources, parsing
    // JSON, pairing flags that only make sense together. What a Gateway is
    // belongs to toAddGatewayInput.
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
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
      const input = toAddGatewayInput(project, {
        name: flags.name,
        protocolType: flags["protocol-type"],
        authorizerType: flags["authorizer-type"],
        authorizerConfiguration,
        enableSemanticSearch: flags["enable-semantic-search"],
        description: flags.description,
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

      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added Gateway '${flags.name}' to '${project.name}'\n`);
    },
  });
