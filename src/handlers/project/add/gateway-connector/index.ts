import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import {
  AgentCoreGatewayTargetSchema,
  type AgentCoreGatewayTarget,
  type ConnectorId,
} from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonFlagWithSchema } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

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
      if (flags["knowledge-base"] !== undefined && flags.connector !== "bedrock-knowledge-bases") {
        throw new InputValidationError(
          "--knowledge-base requires --connector bedrock-knowledge-bases",
        );
      }

      const project = ctx.require(ProjectKey);
      let target: AgentCoreGatewayTarget;
      if (usesConfiguration) {
        const source = new SourceResolver({ stdin: config.io.stdin });
        target = parseJsonFlagWithSchema(
          "connector-configuration",
          await source.resolveText("connector-configuration", flags["connector-configuration"]),
          AgentCoreGatewayTargetSchema,
        )!;
        if (target.targetType !== "connector") {
          throw new InputValidationError(
            '--connector-configuration must have targetType: "connector"',
          );
        }
      } else {
        target = connectorTargetFromShortcut(
          flags.name!,
          flags.connector!,
          flags["knowledge-base"],
        );
      }

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "gateway-target",
        gatewayName: flags.gateway,
        resourceConfig: target,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Connector Target '${target.name}' to Gateway '${flags.gateway}' in '${project.name}'\n`,
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
