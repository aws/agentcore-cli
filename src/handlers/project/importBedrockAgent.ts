import { InputValidationError } from "../../errors";
import type {
  BedrockAgentImportFramework,
  BedrockAgentImportMemory,
  CoreBedrockAgentImporter,
} from "../../core/project/bedrockAgentImport";
import type { Memory } from "../../projectSchemas/memory";
import type { ScaffoldRuntimeInput } from "./types";

/**
 * Imported Bedrock Agents become Python CodeZip runtimes. The translation plan
 * supplies the code while this input supplies the normal project memory entry.
 */
export function importScaffoldRuntimeInput(
  runtimeName: string,
  memory?: Memory,
): ScaffoldRuntimeInput {
  return {
    runtimeName,
    build: "CodeZip",
    language: "Python",
    framework: "none",
    modelProvider: "Bedrock",
    memory,
    runtimeVersion: "PYTHON_3_14",
  };
}

export type ResolveImportInput = {
  importer: CoreBedrockAgentImporter;
  runtimeName: string;
  region: string;
  agentId?: string;
  agentAliasId?: string;
  framework: BedrockAgentImportFramework;
  memory: BedrockAgentImportMemory;
};

/**
 * Validates import addressing and resolves an alias-pinned translation plan.
 */
export async function resolveImportBedrockAgentInput(
  input: ResolveImportInput,
): Promise<Awaited<ReturnType<CoreBedrockAgentImporter["import"]>>> {
  if (!input.agentId || !input.agentAliasId) {
    throw new InputValidationError(
      "importing a Bedrock Agent requires both --agent-id and --agent-alias-id",
    );
  }

  return input.importer.import({
    runtimeName: input.runtimeName,
    region: input.region,
    agentId: input.agentId,
    agentAliasId: input.agentAliasId,
    framework: input.framework,
    memory: input.memory,
  });
}
