import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import {
  AgentCoreGatewayTargetSchema,
  type AgentCoreGatewayTarget,
  type ConnectorId,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { assertMutuallyExclusiveFlags, parseJsonFlagWithSchema } from "../../../utils";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";

// The curated-connector shortcut as the flags state it: which connector, and
// for bedrock-knowledge-bases, which Knowledge Base.
export interface GatewayConnectorShortcutInput {
  gateway: string;
  name: string;
  connector: ConnectorId;
  knowledgeBase?: string;
}

// toAddGatewayConnectorInput builds the Target both shortcut entry points
// produce — the flags, or the wizard's answers — so both write the same
// connector configuration. The full --connector-configuration path bypasses
// it on purpose.
export function toAddGatewayConnectorInput(input: GatewayConnectorShortcutInput): AddResourceInput {
  return {
    resourceType: "gateway-target",
    gatewayName: input.gateway,
    resourceConfig: connectorTargetFromShortcut(input.name, input.connector, input.knowledgeBase),
  };
}

export const createAddGatewayConnectorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-connector",
    description: "add a connector-backed Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().min(1)),
      flag("name", "the Target name for a connector shortcut", z.string().optional()),
      flag(
        "connector",
        "curated connector [bedrock-knowledge-bases | web-search]",
        z.enum(["web-search", "bedrock-knowledge-bases"]).optional(),
      ),
      flag(
        "connector-configuration",
        "complete connector agentCoreGateways[].targets[] object (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "knowledge-base",
        "external ten-character Knowledge Base ID; only for bedrock-knowledge-bases",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      assertMutuallyExclusiveFlags(flags, ["connector", "connector-configuration"], {
        exactlyOne: true,
      });

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
      if (flags["knowledge-base"] !== undefined && flags.connector !== "bedrock-knowledge-bases") {
        throw new InputValidationError(
          "--knowledge-base requires --connector bedrock-knowledge-bases",
        );
      }

      const project = ctx.require(ProjectKey);
      let input: AddResourceInput;
      if (usesConfiguration) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const target = parseJsonFlagWithSchema(
          "connector-configuration",
          await source.resolveText("connector-configuration", flags["connector-configuration"]),
          AgentCoreGatewayTargetSchema,
        )!;
        if (target.targetType !== "connector") {
          throw new InputValidationError(
            '--connector-configuration must have targetType: "connector"',
          );
        }
        input = {
          resourceType: "gateway-target",
          gatewayName: flags.gateway,
          resourceConfig: target,
        };
      } else {
        input = toAddGatewayConnectorInput({
          gateway: flags.gateway,
          name: flags.name!,
          connector: flags.connector!,
          knowledgeBase: flags["knowledge-base"],
        });
      }

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added Connector Target '${input.resourceConfig.name}' to Gateway '${flags.gateway}' in '${project.name}'`,
        { resourceType: "gateway-connector" },
      );
    },
  });

function connectorTargetFromShortcut(
  name: string,
  connectorId: ConnectorId,
  knowledgeBase?: string,
): AgentCoreGatewayTarget {
  switch (connectorId) {
    case "web-search":
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
