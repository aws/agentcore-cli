import { describe, expect, test } from "bun:test";
import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { GatewayConnectorTarget, type GatewayConnectorShortcut } from "./gatewayConnectorTarget";

describe("GatewayConnectorTarget.fromShortcut", () => {
  test.each([
    {
      shortcut: "web-search",
      expected: {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            configurations: [
              {
                name: "WebSearch",
                parameterValues: { maxResults: 10 },
              },
            ],
          },
        },
      },
    },
    {
      shortcut: "bedrock-knowledge-bases",
      knowledgeBaseId: "KB12345678",
      expected: {
        mcp: {
          connector: {
            source: { connectorId: "bedrock-knowledge-bases" },
            configurations: [
              {
                name: "Retrieve",
                parameterValues: { knowledgeBaseId: "KB12345678" },
              },
            ],
          },
        },
      },
    },
    {
      shortcut: "bedrock-mantle",
      expected: {
        inference: {
          connector: {
            source: { connectorId: "bedrock-mantle" },
          },
        },
      },
    },
  ] as {
    shortcut: GatewayConnectorShortcut;
    knowledgeBaseId?: string;
    expected: TargetConfiguration;
  }[])("builds the $shortcut configuration", ({ shortcut, knowledgeBaseId, expected }) => {
    expect(GatewayConnectorTarget.fromShortcut(shortcut, knowledgeBaseId)).toEqual(expected);
  });

  test("requires a Knowledge Base ID", () => {
    expect(() => GatewayConnectorTarget.fromShortcut("bedrock-knowledge-bases")).toThrow(
      /Knowledge Base ID/,
    );
  });
});
