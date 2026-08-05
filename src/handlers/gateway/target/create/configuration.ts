import type {
  ApiSchemaConfiguration,
  McpToolSchemaConfiguration,
  TargetConfiguration,
  ToolDefinition,
  ToolSchema,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../../errors";
import type { SourceResolver } from "../../../../io";
import { parseJsonArrayFlag, parseJsonObjectFlag } from "../../../utils";

type TargetConfigurationInput = {
  endpoint?: string;
  lambdaArn?: string;
  openapiSchema?: string;
  smithyModel?: string;
  runtimeArn?: string;
  passthroughEndpoint?: string;
  targetConfiguration?: string;
  toolSchema?: string;
  qualifier?: string;
  passthroughProtocol?: "mcp" | "a2a" | "inference" | "custom";
};

const TARGET_INPUT_NAMES = [
  "endpoint",
  "lambda-arn",
  "openapi-schema",
  "smithy-model",
  "runtime-arn",
  "passthrough-endpoint",
  "target-configuration",
] as const;

export class TargetConfigurationResolver {
  constructor(private readonly source: SourceResolver) {}

  async resolve(input: TargetConfigurationInput): Promise<TargetConfiguration> {
    this.validate(input);

    if (input.targetConfiguration) {
      return parseJsonObjectFlag<TargetConfiguration>(
        "target-configuration",
        await this.source.resolveText("target-configuration", input.targetConfiguration),
      )!;
    }
    if (input.endpoint) {
      const mcpToolSchema = await this.mcpToolSchema(input.toolSchema);
      return {
        mcp: {
          mcpServer: {
            endpoint: input.endpoint,
            ...(mcpToolSchema ? { mcpToolSchema } : {}),
          },
        },
      };
    }
    if (input.lambdaArn) {
      return {
        mcp: {
          lambda: {
            lambdaArn: input.lambdaArn,
            toolSchema: await this.lambdaToolSchema(input.toolSchema!),
          },
        },
      };
    }
    if (input.openapiSchema) {
      return {
        mcp: { openApiSchema: await this.apiSchema("openapi-schema", input.openapiSchema) },
      };
    }
    if (input.smithyModel) {
      return { mcp: { smithyModel: await this.apiSchema("smithy-model", input.smithyModel) } };
    }
    if (input.runtimeArn) {
      return {
        http: {
          agentcoreRuntime: {
            arn: input.runtimeArn,
            ...(input.qualifier ? { qualifier: input.qualifier } : {}),
          },
        },
      };
    }
    return {
      http: {
        passthrough: {
          endpoint: input.passthroughEndpoint!,
          protocolType: input.passthroughProtocol!.toUpperCase() as
            "MCP" | "A2A" | "INFERENCE" | "CUSTOM",
        },
      },
    };
  }

  private validate(input: TargetConfigurationInput): void {
    const values = [
      input.endpoint,
      input.lambdaArn,
      input.openapiSchema,
      input.smithyModel,
      input.runtimeArn,
      input.passthroughEndpoint,
      input.targetConfiguration,
    ];
    if (values.filter((value) => value !== undefined).length !== 1) {
      throw new InputValidationError(
        `specify exactly one of ${TARGET_INPUT_NAMES.map((name) => `'--${name}'`).join(", ")}`,
      );
    }

    const guidedOptions = [
      ["tool-schema", input.toolSchema],
      ["qualifier", input.qualifier],
      ["passthrough-protocol", input.passthroughProtocol],
    ] as const;
    if (input.targetConfiguration && guidedOptions.some(([, value]) => value !== undefined)) {
      throw new InputValidationError(
        "--target-configuration conflicts with guided Target input options",
      );
    }
    if (input.toolSchema && !input.endpoint && !input.lambdaArn) {
      throw new InputValidationError("--tool-schema requires --endpoint or --lambda-arn");
    }
    if (input.lambdaArn && !input.toolSchema) {
      throw new InputValidationError("--lambda-arn requires --tool-schema");
    }
    if (input.qualifier && !input.runtimeArn) {
      throw new InputValidationError("--qualifier requires --runtime-arn");
    }
    if (input.passthroughEndpoint && !input.passthroughProtocol) {
      throw new InputValidationError("--passthrough-endpoint requires --passthrough-protocol");
    }
    if (input.passthroughProtocol && !input.passthroughEndpoint) {
      throw new InputValidationError("--passthrough-protocol requires --passthrough-endpoint");
    }
  }

  private async apiSchema(name: string, value: string): Promise<ApiSchemaConfiguration> {
    if (value.startsWith("s3://")) return { s3: { uri: value } };
    return { inlinePayload: (await this.source.resolveText(name, value))! };
  }

  private async mcpToolSchema(
    value: string | undefined,
  ): Promise<McpToolSchemaConfiguration | undefined> {
    if (!value) return undefined;
    if (value.startsWith("s3://")) return { s3: { uri: value } };
    return { inlinePayload: (await this.source.resolveText("tool-schema", value))! };
  }

  private async lambdaToolSchema(value: string): Promise<ToolSchema> {
    if (value.startsWith("s3://")) return { s3: { uri: value } };
    return {
      inlinePayload: parseJsonArrayFlag<ToolDefinition>(
        "tool-schema",
        await this.source.resolveText("tool-schema", value),
      )!,
    };
  }
}
