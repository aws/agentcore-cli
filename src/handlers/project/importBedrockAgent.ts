import { InputValidationError } from "../../errors";
import {
  BEDROCK_AGENT_IMPORT_REGIONS,
  type DescribeBedrockAgent,
} from "../../core/project/bedrockAgent";
import type { ImportBedrockAgentInput } from "./add/runtime/types";
import type { ScaffoldRuntimeInput } from "./types";

/**
 * The fixed scaffold shape of a Bedrock Agent proxy runtime: plain Python,
 * CodeZip. The proxy template supplies the code; these values only shape the
 * runtime spec entry.
 */
export function importScaffoldRuntimeInput(runtimeName: string): ScaffoldRuntimeInput {
  return {
    runtimeName,
    build: "CodeZip",
    language: "Python",
    framework: "none",
    modelProvider: "Bedrock",
    runtimeVersion: "PYTHON_3_14",
  };
}

export type ResolveImportInput = {
  describeBedrockAgent: DescribeBedrockAgent;
  /** The CLI's effective region (--region flag, env, shared config). */
  region: string;
  agentId?: string;
  agentAliasId?: string;
};

/**
 * Validates the import addressing, describes the agent and alias through the
 * service, and returns the proxy scaffold's input plus any advisory warnings.
 */
export async function resolveImportBedrockAgentInput(
  input: ResolveImportInput,
): Promise<{ imported: ImportBedrockAgentInput; warnings: string[] }> {
  if (!input.agentId || !input.agentAliasId) {
    throw new InputValidationError("--type import requires both --agent-id and --agent-alias-id");
  }

  const region = BEDROCK_AGENT_IMPORT_REGIONS.find((candidate) => candidate === input.region);
  if (!region) {
    throw new InputValidationError(
      `'${input.region}' is not a supported Bedrock Agent region for import. ` +
        `Supported regions: ${BEDROCK_AGENT_IMPORT_REGIONS.join(", ")}. ` +
        `Pass --region <region> to select the agent's region.`,
    );
  }

  const metadata = await input.describeBedrockAgent({
    region,
    agentId: input.agentId,
    agentAliasId: input.agentAliasId,
  });

  const warnings: string[] = [];
  if (metadata.agentStatus !== "PREPARED") {
    warnings.push(
      `Warning: Bedrock Agent '${metadata.agentName}' is in status ${metadata.agentStatus} ` +
        `(not PREPARED); invocations may fail until it is prepared.`,
    );
  }

  return {
    imported: {
      agentId: input.agentId,
      agentAliasId: input.agentAliasId,
      region,
      agentName: metadata.agentName,
      agentAliasArn: metadata.agentAliasArn,
      ...(metadata.foundationModel && { foundationModel: metadata.foundationModel }),
      ...(metadata.description && { description: metadata.description }),
    },
    warnings,
  };
}
