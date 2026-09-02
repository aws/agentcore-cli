import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { Credential } from "../../../../projectSchemas/credential";
import {
  AgentCoreGatewayTargetSchema,
  type AgentCoreGatewayTarget,
  type OutboundAuth,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonFlagWithSchema } from "../../../utils";
import type { Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";

export const createAddGatewayTargetHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-target",
    description: "adds a Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().optional()),
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
Use project add gateway-connector for curated Connector shortcuts.`,
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
      if (!flags.gateway) {
        throw new InputValidationError("required option '--gateway <gateway>' not specified");
      }
      const modes = [
        ["--endpoint", flags.endpoint],
        ["--runtime", flags.runtime],
        ["--target-configuration", flags["target-configuration"]],
      ].filter(([, value]) => value !== undefined);
      if (modes.length !== 1) {
        throw new InputValidationError(
          "specify exactly one of '--endpoint', '--runtime', or '--target-configuration'",
        );
      }
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
      let target: AgentCoreGatewayTarget;
      if (usesConfiguration) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        target = parseJsonFlagWithSchema(
          "target-configuration",
          await source.resolveText("target-configuration", flags["target-configuration"]),
          AgentCoreGatewayTargetSchema,
        )!;
        validateTargetCredential(project, target);
      } else {
        const outboundAuth = projectOutboundAuth(project, {
          type: flags["outbound-auth"],
          credentialName: flags["credential-name"],
          scopes: flags.scope,
        });
        target =
          flags.endpoint !== undefined
            ? {
                name: flags.name!,
                targetType: "mcpServer",
                endpoint: httpsEndpoint(flags.endpoint, "--endpoint"),
                outboundAuth,
              }
            : {
                name: flags.name!,
                targetType: "httpRuntime",
                httpRuntime: {
                  runtime: flags.runtime!,
                  runtimeEndpoint: flags["runtime-endpoint"],
                },
                outboundAuth,
              };
      }

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "gateway-target",
        gatewayName: flags.gateway,
        resourceConfig: target,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Target '${target.name}' to Gateway '${flags.gateway}' in '${project.name}'\n`,
      );
    },
  });

type OutboundAuthInput = {
  type?: "none" | "oauth" | "api-key";
  credentialName?: string;
  scopes?: string[];
};

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
    throw new InputValidationError(`credential '${name}' does not exist in credentials[]`);
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
  try {
    if (new URL(value).protocol !== "https:") {
      throw new InputValidationError(`${option} must use HTTPS`);
    }
  } catch (error) {
    if (error instanceof InputValidationError) throw error;
    throw new InputValidationError(`${option} must be a valid HTTPS URL`, { cause: error });
  }
  return value;
}
