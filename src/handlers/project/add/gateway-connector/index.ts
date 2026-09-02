import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import {
  AgentCoreGatewayTargetSchema,
  type AgentCoreGatewayTarget,
  type ConnectorId,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { formatZodError } from "../../../../router/schema";
import { parseJsonFlag } from "../../../utils";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

type AddGatewayTargetInput = Extract<AddResourceInput, { resourceType: "gateway-target" }>;

/**
 * GatewayConnectorInput is what every entry point — the flag handler, the
 * wizard — resolves its own inputs to before a connector Target is built. A
 * Target is either a curated shortcut (a connector ID plus the one value it
 * needs) or a complete Target object supplied as parsed JSON.
 */
export interface GatewayConnectorInput {
  gatewayName: string;
  target:
    | { kind: "shortcut"; name: string; connectorId: ConnectorId; knowledgeBase?: string }
    | { kind: "configuration"; configuration: unknown };
}

/**
 * toAddGatewayConnectorInput is the one place a connector Target is assembled
 * from user input: the curated shortcuts' default configurations, the
 * Knowledge Base rule, the shape a complete configuration must have. Both the
 * flag handler and the wizard call it.
 */
export function toAddGatewayConnectorInput(input: GatewayConnectorInput): AddGatewayTargetInput {
  const target =
    input.target.kind === "configuration"
      ? connectorTargetFromConfiguration(input.target.configuration)
      : connectorTargetFromShortcut(
          input.target.name,
          input.target.connectorId,
          input.target.knowledgeBase,
        );
  return { resourceType: "gateway-target", gatewayName: input.gatewayName, resourceConfig: target };
}

function connectorTargetFromConfiguration(configuration: unknown): AgentCoreGatewayTarget {
  const parsed = AgentCoreGatewayTargetSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new InputValidationError(
      `Invalid value for option '--connector-configuration': ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (parsed.data.targetType !== "connector") {
    throw new InputValidationError('--connector-configuration must have targetType: "connector"');
  }
  return parsed.data;
}

function connectorTargetFromShortcut(
  name: string,
  connectorId: ConnectorId,
  knowledgeBase?: string,
): AgentCoreGatewayTarget {
  switch (connectorId) {
    case "web-search":
      if (knowledgeBase !== undefined) {
        throw new InputValidationError(
          "--knowledge-base requires --connector bedrock-knowledge-bases",
        );
      }
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      };
    case "bedrock-knowledge-bases":
      if (!knowledgeBase) {
        throw new InputValidationError(
          "--connector bedrock-knowledge-bases requires --knowledge-base",
        );
      }
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: knowledgeBase } }],
      };
  }
}

export const createAddGatewayConnectorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-connector",
    description: "adds a connector-backed Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().optional()),
      flag("name", "the Target name for a connector shortcut", z.string().optional()),
      flag(
        "connector",
        "curated connector",
        z.enum(["web-search", "bedrock-knowledge-bases"]).optional(),
      ),
      flag(
        "connector-configuration",
        "complete connector agentCoreGateways[].targets[] object (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "knowledge-base",
        "project Knowledge Base name or external ten-character ID; only for bedrock-knowledge-bases",
        z.string().optional(),
      ),
    ],
    // handle only turns flags into a GatewayConnectorInput — deciding which of
    // the two forms was given and reading the configuration from its source.
    // What a connector Target is belongs to toAddGatewayConnectorInput.
    handle: async (ctx, flags) => {
      if (!flags.gateway) {
        throw new InputValidationError("required option '--gateway <gateway>' not specified");
      }
      if ((flags.connector === undefined) === (flags["connector-configuration"] === undefined)) {
        throw new InputValidationError(
          "specify exactly one of '--connector' or '--connector-configuration'",
        );
      }

      const usesConfiguration = flags["connector-configuration"] !== undefined;
      if (usesConfiguration && flags.name !== undefined) {
        throw new InputValidationError(
          "--name is part of --connector-configuration and cannot be supplied separately",
        );
      }
      if (usesConfiguration && flags["knowledge-base"] !== undefined) {
        throw new InputValidationError(
          "--knowledge-base cannot be combined with --connector-configuration",
        );
      }
      if (!usesConfiguration && !flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const project = ctx.require(ProjectKey);
      let input: AddGatewayTargetInput;
      if (usesConfiguration) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const configuration = parseJsonFlag<unknown>(
          "connector-configuration",
          await source.resolveText("connector-configuration", flags["connector-configuration"]),
        );
        input = toAddGatewayConnectorInput({
          gatewayName: flags.gateway,
          target: { kind: "configuration", configuration },
        });
      } else {
        input = toAddGatewayConnectorInput({
          gatewayName: flags.gateway,
          target: {
            kind: "shortcut",
            name: flags.name!,
            connectorId: flags.connector!,
            knowledgeBase: flags["knowledge-base"],
          },
        });
      }
      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Connector Target '${input.resourceConfig.name}' to Gateway '${flags.gateway}' in '${project.name}'\n`,
      );
    },
  });
