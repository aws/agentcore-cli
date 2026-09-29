import z from "zod";
import { InputValidationError, ResourceNotFoundError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { Credential } from "../../../../projectSchemas/credential";
import {
  AgentCoreGatewayTargetSchema,
  type AgentCoreGatewayTarget,
  type OutboundAuth,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { assertMutuallyExclusiveFlags, parseJsonFlagWithSchema } from "../../../utils";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";

// HttpsEndpointSchema is what --endpoint and the wizard's endpoint step both
// check an MCP server URL against, so they refuse the same values in the same
// words.
export const HttpsEndpointSchema = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a valid HTTPS URL" });
    return;
  }
  if (url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "must use HTTPS" });
});

export type OutboundAuthInput = {
  type?: "none" | "oauth" | "api-key";
  credentialName?: string;
  scopes?: string[];
};

// The two shortcut Targets: an MCP server at an HTTPS endpoint, or a Runtime
// declared in this project. Exactly one of endpoint and runtime is set.
export interface GatewayTargetShortcutInput {
  gateway: string;
  name: string;
  endpoint?: string;
  runtime?: string;
  runtimeEndpoint?: string;
  outboundAuth: OutboundAuthInput;
}

// toAddGatewayTargetInput builds the Target both shortcut entry points produce —
// the flags, or the wizard's answers — including the credential lookup and
// type check, so a value one path refuses the other refuses with the same
// message. The full --target-configuration path bypasses it on purpose.
export function toAddGatewayTargetInput(
  project: Project,
  input: GatewayTargetShortcutInput,
): AddResourceInput {
  const outboundAuth = projectOutboundAuth(project, input.outboundAuth);
  const target: AgentCoreGatewayTarget =
    input.endpoint !== undefined
      ? {
          name: input.name,
          targetType: "mcpServer",
          endpoint: httpsEndpoint(input.endpoint, "--endpoint"),
          outboundAuth,
        }
      : {
          name: input.name,
          targetType: "httpRuntime",
          httpRuntime: {
            runtime: input.runtime!,
            runtimeEndpoint: input.runtimeEndpoint,
          },
          outboundAuth,
        };
  return { resourceType: "gateway-target", gatewayName: input.gateway, resourceConfig: target };
}

export const createAddGatewayTargetHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-target",
    description: "add a Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().min(1)),
      flag("name", "the Target name for endpoint or Runtime shortcuts", z.string().optional()),
      flag("endpoint", "external MCP server HTTPS endpoint", z.string().optional()),
      flag("runtime", "name of a Runtime declared in this project", z.string().optional()),
      flag("runtime-endpoint", "named endpoint on the selected Runtime", z.string().optional()),
      flag(
        "target-configuration",
        "complete agentCoreGateways[].targets[] object (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
        {
          help: `(JSON: agentCoreGateways[].targets[] object)
Use --endpoint for an external MCP server or --runtime for a project Runtime.
For every complete project Target shape, pass targetType and its configuration here.
Supported targetType values: mcpServer, httpRuntime, apiGateway, openApiSchema,
smithyModel, lambdaFunctionArn, connector, and passthrough.
Use agentcore add gateway-connector for curated Connector shortcuts.`,
        },
      ),
      flag(
        "outbound-auth",
        "shortcut Target authentication: none, oauth, or api-key",
        z.enum(["none", "oauth", "api-key"]).optional(),
      ),
      flag(
        "credential-name",
        "name of a compatible credential declared in this project",
        z.string().optional(),
      ),
      flag("scope", "OAuth scope", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      assertMutuallyExclusiveFlags(flags, ["endpoint", "runtime", "target-configuration"], {
        exactlyOne: true,
      });
      if (flags["runtime-endpoint"] !== undefined && flags.runtime === undefined) {
        throw new InputValidationError("--runtime-endpoint requires --runtime");
      }

      const usesConfiguration = flags["target-configuration"] !== undefined;
      if (usesConfiguration && flags.name !== undefined) {
        throw new InputValidationError(
          "--name is part of --target-configuration and cannot be supplied separately",
        );
      }
      if (
        usesConfiguration &&
        (flags["outbound-auth"] !== undefined ||
          flags["credential-name"] !== undefined ||
          flags.scope !== undefined)
      ) {
        throw new InputValidationError(
          "outboundAuth is part of --target-configuration; shortcut auth flags cannot be combined with it",
        );
      }
      if (!usesConfiguration && !flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const project = ctx.require(ProjectKey);
      let input: AddResourceInput;
      if (usesConfiguration) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const target = parseJsonFlagWithSchema(
          "target-configuration",
          await source.resolveText("target-configuration", flags["target-configuration"]),
          AgentCoreGatewayTargetSchema,
        )!;
        validateTargetCredential(project, target);
        input = {
          resourceType: "gateway-target",
          gatewayName: flags.gateway,
          resourceConfig: target,
        };
      } else {
        input = toAddGatewayTargetInput(project, {
          gateway: flags.gateway,
          name: flags.name!,
          endpoint: flags.endpoint,
          runtime: flags.runtime,
          runtimeEndpoint: flags["runtime-endpoint"],
          outboundAuth: {
            type: flags["outbound-auth"],
            credentialName: flags["credential-name"],
            scopes: flags.scope,
          },
        });
      }

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added Target '${input.resourceConfig.name}' to Gateway '${flags.gateway}' in '${project.name}'`,
      );
    },
  });

function projectOutboundAuth(project: Project, input: OutboundAuthInput): OutboundAuth | undefined {
  if (!input.type) {
    if (input.credentialName) {
      throw new InputValidationError("--credential-name requires --outbound-auth oauth or api-key");
    }
    if (input.scopes) {
      throw new InputValidationError("--scope requires --outbound-auth oauth");
    }
    return undefined;
  }
  if (input.type === "none") {
    if (input.credentialName || input.scopes) {
      throw new InputValidationError(
        "--outbound-auth none cannot be combined with --credential-name or --scope",
      );
    }
    return { type: "NONE" };
  }
  if (!input.credentialName) {
    throw new InputValidationError(`--outbound-auth ${input.type} requires --credential-name`);
  }
  if (input.type === "api-key" && input.scopes) {
    throw new InputValidationError("--scope is valid only with --outbound-auth oauth");
  }

  const credential = requireCredential(project, input.credentialName);
  assertCredentialType(credential, input.type);
  return {
    type: input.type === "oauth" ? "OAUTH" : "API_KEY",
    credentialName: input.credentialName,
    scopes: input.type === "oauth" ? input.scopes : undefined,
  };
}

function validateTargetCredential(project: Project, target: AgentCoreGatewayTarget): void {
  const auth = target.outboundAuth;
  if (!auth?.credentialName) return;

  const credential = requireCredential(project, auth.credentialName);
  if (auth.type === "OAUTH") assertCredentialType(credential, "oauth");
  if (auth.type === "API_KEY") assertCredentialType(credential, "api-key");
}

function requireCredential(project: Project, name: string): Credential {
  const credential = project.spec.credentials.find((candidate) => candidate.name === name);
  if (!credential) {
    throw new ResourceNotFoundError(`no credential named '${name}' exists in this project`);
  }
  return credential;
}

function assertCredentialType(credential: Credential, auth: "oauth" | "api-key"): void {
  const expected = auth === "oauth" ? "OAuthCredentialProvider" : "ApiKeyCredentialProvider";
  if (credential.authorizerType !== expected) {
    throw new InputValidationError(
      `credential '${credential.name}' is a ${credential.authorizerType}, not a ${expected}`,
    );
  }
}

function httpsEndpoint(value: string, option: string): string {
  const parsed = HttpsEndpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(`${option} ${parsed.error.issues[0]!.message}`, {
      cause: parsed.error,
    });
  }
  return value;
}
