import { InputValidationError, MalformedServiceResponseError } from "../../errors";

/**
 * Regions where an Amazon Bedrock Agent can live for `--type import`,
 * mirroring the original CLI's supported-region list.
 */
export const BEDROCK_AGENT_IMPORT_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
  "us-gov-west-1",
] as const;

export type BedrockAgentImportRegion = (typeof BEDROCK_AGENT_IMPORT_REGIONS)[number];

export type DescribeBedrockAgentInput = {
  region: string;
  agentId: string;
  agentAliasId: string;
};

/** What the proxy scaffold needs to know about the imported agent. */
export type BedrockAgentMetadata = {
  agentName: string;
  agentStatus: string;
  agentAliasArn: string;
  agentAliasName: string;
  agentAliasStatus: string;
  foundationModel?: string;
  description?: string;
};

export type DescribeBedrockAgent = (
  input: DescribeBedrockAgentInput,
) => Promise<BedrockAgentMetadata>;

function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * Describes the agent and its alias through the Bedrock Agent control plane,
 * both to fail fast on a nonexistent agent/alias and to capture the metadata
 * the scaffolded proxy embeds.
 */
export const describeBedrockAgent: DescribeBedrockAgent = async (input) => {
  const { BedrockAgentClient, GetAgentCommand, GetAgentAliasCommand } =
    await import("@aws-sdk/client-bedrock-agent");
  const client = new BedrockAgentClient({ region: input.region });

  let agent;
  try {
    ({ agent } = await client.send(new GetAgentCommand({ agentId: input.agentId })));
  } catch (error) {
    if (isNamedError(error, "ResourceNotFoundException")) {
      throw new InputValidationError(
        `no Bedrock Agent with id '${input.agentId}' exists in ${input.region}; ` +
          `check --agent-id and --region`,
        { cause: error },
      );
    }
    throw error;
  }

  let agentAlias;
  try {
    ({ agentAlias } = await client.send(
      new GetAgentAliasCommand({ agentId: input.agentId, agentAliasId: input.agentAliasId }),
    ));
  } catch (error) {
    if (isNamedError(error, "ResourceNotFoundException")) {
      throw new InputValidationError(
        `Bedrock Agent '${input.agentId}' has no alias with id '${input.agentAliasId}' in ` +
          `${input.region}; check --agent-alias-id`,
        { cause: error },
      );
    }
    throw error;
  }

  if (!agent?.agentName || !agentAlias?.agentAliasArn || !agentAlias.agentAliasName) {
    throw new MalformedServiceResponseError(
      `the Bedrock Agent service returned an incomplete description for agent ` +
        `'${input.agentId}' / alias '${input.agentAliasId}'`,
    );
  }

  return {
    agentName: agent.agentName,
    agentStatus: agent.agentStatus ?? "UNKNOWN",
    agentAliasArn: agentAlias.agentAliasArn,
    agentAliasName: agentAlias.agentAliasName,
    agentAliasStatus: agentAlias.agentAliasStatus ?? "UNKNOWN",
    foundationModel: agent.foundationModel,
    description: agent.description,
  };
};
