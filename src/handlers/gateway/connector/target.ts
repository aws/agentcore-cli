import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";

export type GatewayConnectorShortcut = "web-search" | "bedrock-knowledge-bases" | "bedrock-mantle";

export class GatewayConnectorTarget {
  static is(configuration: TargetConfiguration | undefined): boolean {
    return (
      configuration?.mcp?.connector !== undefined ||
      configuration?.inference?.connector !== undefined
    );
  }

  static fromShortcut(
    shortcut: GatewayConnectorShortcut,
    knowledgeBaseId?: string,
  ): TargetConfiguration {
    if (shortcut === "bedrock-mantle") {
      return { inference: { connector: { source: { connectorId: shortcut } } } };
    }

    if (shortcut === "bedrock-knowledge-bases" && !knowledgeBaseId) {
      throw new Error("A Knowledge Base ID is required for the bedrock-knowledge-bases connector");
    }

    return {
      mcp: {
        connector: {
          source: { connectorId: shortcut },
          ...(shortcut === "bedrock-knowledge-bases"
            ? {
                configurations: [
                  {
                    name: "Retrieve",
                    parameterValues: { knowledgeBaseId: knowledgeBaseId! },
                  },
                ],
              }
            : {}),
        },
      },
    };
  }
}
