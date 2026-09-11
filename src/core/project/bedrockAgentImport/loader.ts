import {
  BedrockAgentClient,
  GetAgentActionGroupCommand,
  GetAgentAliasCommand,
  GetAgentVersionCommand,
  GetKnowledgeBaseCommand,
  ListAgentActionGroupsCommand,
  ListAgentCollaboratorsCommand,
  ListAgentKnowledgeBasesCommand,
  type AgentActionGroup,
  type AgentVersion,
} from "@aws-sdk/client-bedrock-agent";
import {
  InputValidationError,
  MalformedServiceResponseError,
  ResourceNotFoundError,
} from "../../../errors";
import type {
  BedrockAgentImportNote,
  BedrockAgentSnapshot,
  ImportedActionGroup,
  ImportedCollaborator,
  ImportedInferenceConfiguration,
  ImportedKnowledgeBase,
} from "./types";

export type CreateBedrockAgentClient = (region: string) => BedrockAgentClient;

const ALIAS_ARN_PATTERN = /^arn:[^:]+:bedrock:[^:]+:[^:]+:agent-alias\/([^/]+)\/([^/]+)$/;

export class BedrockAgentSnapshotLoader {
  constructor(
    private readonly createClient: CreateBedrockAgentClient = (region) =>
      new BedrockAgentClient({ region }),
  ) {}

  async load(input: {
    region: string;
    agentId: string;
    agentAliasId: string;
  }): Promise<BedrockAgentSnapshot> {
    const client = this.createClient(input.region);
    const sourceVersion = await this.resolveAliasVersion(
      client,
      input.agentId,
      input.agentAliasId,
      {
        region: input.region,
        notFound:
          `Bedrock Agent '${input.agentId}' has no alias with id '${input.agentAliasId}' in ` +
          `${input.region}; check --agent-id, --agent-alias-id, and --region`,
      },
    );

    const snapshot = await this.loadVersion(
      client,
      {
        region: input.region,
        agentId: input.agentId,
        agentVersion: sourceVersion,
      },
      new Set<string>(),
    );
    if (!snapshot) {
      throw new MalformedServiceResponseError(
        `the selected Bedrock Agent version '${input.agentId}:${sourceVersion}' could not be loaded`,
      );
    }
    return snapshot;
  }

  /**
   * An alias names a routing target, not a snapshot. Resolve it to the single immutable version it
   * routes to, rejecting DRAFT, which is mutable and has no GetAgentVersion representation. Used
   * for the requested agent and for every collaborator, which the service also identifies by alias.
   */
  private async resolveAliasVersion(
    client: BedrockAgentClient,
    agentId: string,
    agentAliasId: string,
    messages: { region: string; notFound: string },
  ): Promise<string> {
    let alias;
    try {
      ({ agentAlias: alias } = await client.send(
        new GetAgentAliasCommand({ agentId, agentAliasId }),
      ));
    } catch (error) {
      if (isNamedError(error, "ResourceNotFoundException")) {
        throw new InputValidationError(messages.notFound, { cause: error });
      }
      throw error;
    }

    if (
      !alias ||
      alias.agentId !== agentId ||
      alias.agentAliasId !== agentAliasId ||
      !alias.agentAliasName
    ) {
      throw new MalformedServiceResponseError(
        `the Bedrock Agent service returned an incomplete alias description for agent ` +
          `'${agentId}' / alias '${agentAliasId}'`,
      );
    }

    const routing = alias.routingConfiguration ?? [];
    const version = routing.length === 1 ? routing[0]?.agentVersion : undefined;
    if (!version) {
      throw new InputValidationError(
        `Bedrock Agent alias '${alias.agentAliasName}' does not route to exactly one agent version`,
      );
    }
    if (version === "DRAFT") {
      throw new InputValidationError(
        `Bedrock Agent alias '${alias.agentAliasName}' routes to the mutable DRAFT version; ` +
          "import requires a prepared version. Create a version and an alias that points at it, " +
          "then pass that alias with --agent-alias-id",
      );
    }
    return version;
  }

  private async loadVersion(
    client: BedrockAgentClient,
    input: {
      region: string;
      agentId: string;
      agentVersion: string;
    },
    visited: Set<string>,
  ): Promise<BedrockAgentSnapshot | undefined> {
    const visitKey = `${input.agentId}:${input.agentVersion}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    let agentVersion: AgentVersion | undefined;
    try {
      ({ agentVersion } = await client.send(
        new GetAgentVersionCommand({
          agentId: input.agentId,
          agentVersion: input.agentVersion,
        }),
      ));
    } catch (error) {
      if (isNamedError(error, "ResourceNotFoundException")) {
        throw new ResourceNotFoundError(
          `no version '${input.agentVersion}' exists for Bedrock Agent '${input.agentId}' in ${input.region}`,
          { cause: error },
        );
      }
      throw error;
    }

    if (
      !agentVersion ||
      agentVersion.agentId !== input.agentId ||
      agentVersion.version !== input.agentVersion ||
      !agentVersion.agentName ||
      !agentVersion.foundationModel
    ) {
      throw new MalformedServiceResponseError(
        `the Bedrock Agent service returned an incomplete description for agent ` +
          `'${input.agentId}' version '${input.agentVersion}'`,
      );
    }

    const notes: BedrockAgentImportNote[] = [];
    const [actionGroups, knowledgeBases, collaborators] = await Promise.all([
      this.loadActionGroups(client, input.agentId, input.agentVersion),
      this.loadKnowledgeBases(client, input.agentId, input.agentVersion, notes),
      this.loadCollaborators(
        client,
        input.region,
        input.agentId,
        input.agentVersion,
        visited,
        notes,
      ),
    ]);

    return {
      region: input.region,
      sourceAgentId: input.agentId,
      sourceAgentVersion: input.agentVersion,
      agentName: agentVersion.agentName,
      description: agentVersion.description,
      foundationModel: agentVersion.foundationModel,
      instruction: agentVersion.instruction ?? "",
      inferenceConfiguration: orchestrationInference(agentVersion),
      hasPromptOverrides: hasPromptOverrides(agentVersion),
      guardrail:
        agentVersion.guardrailConfiguration?.guardrailIdentifier &&
        agentVersion.guardrailConfiguration.guardrailVersion
          ? {
              identifier: agentVersion.guardrailConfiguration.guardrailIdentifier,
              version: agentVersion.guardrailConfiguration.guardrailVersion,
            }
          : undefined,
      sourceMemoryEnabled: (agentVersion.memoryConfiguration?.enabledMemoryTypes?.length ?? 0) > 0,
      actionGroups,
      knowledgeBases,
      collaborators,
      notes,
    };
  }

  private async loadActionGroups(
    client: BedrockAgentClient,
    agentId: string,
    agentVersion: string,
  ): Promise<ImportedActionGroup[]> {
    const actionGroupIds: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListAgentActionGroupsCommand({ agentId, agentVersion, nextToken }),
      );
      for (const summary of page.actionGroupSummaries ?? []) {
        if (summary.actionGroupState === "ENABLED" && summary.actionGroupId) {
          actionGroupIds.push(summary.actionGroupId);
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);

    return Promise.all(
      actionGroupIds.map(async (actionGroupId) => {
        const response = await client.send(
          new GetAgentActionGroupCommand({ agentId, agentVersion, actionGroupId }),
        );
        return normalizeActionGroup(response.agentActionGroup, {
          agentId,
          agentVersion,
          actionGroupId,
        });
      }),
    );
  }

  private async loadKnowledgeBases(
    client: BedrockAgentClient,
    agentId: string,
    agentVersion: string,
    notes: BedrockAgentImportNote[],
  ): Promise<ImportedKnowledgeBase[]> {
    const summaries: { id: string; description?: string }[] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListAgentKnowledgeBasesCommand({ agentId, agentVersion, nextToken }),
      );
      for (const summary of page.agentKnowledgeBaseSummaries ?? []) {
        if (summary.knowledgeBaseState === "ENABLED" && summary.knowledgeBaseId) {
          summaries.push({
            id: summary.knowledgeBaseId,
            description: summary.description,
          });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);

    return Promise.all(
      summaries.map(async (summary) => {
        try {
          const response = await client.send(
            new GetKnowledgeBaseCommand({ knowledgeBaseId: summary.id }),
          );
          return {
            id: summary.id,
            name: response.knowledgeBase?.name ?? summary.id,
            description: summary.description ?? response.knowledgeBase?.description,
            arn: response.knowledgeBase?.knowledgeBaseArn,
          };
        } catch (error) {
          notes.push({
            category: "knowledge-base-details",
            message:
              `Could not read details for knowledge base '${summary.id}': ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              "The generated tool uses the ID and requires manual IAM verification.",
          });
          return {
            id: summary.id,
            name: summary.id,
            description: summary.description,
          };
        }
      }),
    );
  }

  private async loadCollaborators(
    client: BedrockAgentClient,
    region: string,
    agentId: string,
    agentVersion: string,
    visited: Set<string>,
    notes: BedrockAgentImportNote[],
  ): Promise<ImportedCollaborator[]> {
    const summaries = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListAgentCollaboratorsCommand({ agentId, agentVersion, nextToken }),
      );
      summaries.push(...(page.agentCollaboratorSummaries ?? []));
      nextToken = page.nextToken;
    } while (nextToken);

    const collaborators: ImportedCollaborator[] = [];
    for (const summary of summaries) {
      // `agentId` and `agentVersion` on a collaborator summary describe the SUPERVISOR that owns
      // the collaboration, not the collaborator. Only agentDescriptor.aliasArn identifies the
      // collaborator, so reading agentId here would resolve every collaborator to its own parent.
      const arnMatch = summary.agentDescriptor?.aliasArn
        ? ALIAS_ARN_PATTERN.exec(summary.agentDescriptor.aliasArn)
        : undefined;
      const collaboratorAgentId = arnMatch?.[1];
      const collaboratorAliasId = arnMatch?.[2];
      if (
        !summary.collaboratorName ||
        !summary.collaborationInstruction ||
        !collaboratorAgentId ||
        !collaboratorAliasId
      ) {
        throw new MalformedServiceResponseError(
          `the Bedrock Agent service returned an incomplete collaborator for agent ` +
            `'${agentId}' version '${agentVersion}'`,
        );
      }

      const collaboratorVersion = await this.resolveAliasVersion(
        client,
        collaboratorAgentId,
        collaboratorAliasId,
        {
          region,
          notFound:
            `Collaborator '${summary.collaboratorName}' of Bedrock Agent '${agentId}' points at ` +
            `alias '${collaboratorAliasId}' of agent '${collaboratorAgentId}', which does not ` +
            `exist in ${region}`,
        },
      );

      const collaborator = await this.loadVersion(
        client,
        {
          region,
          agentId: collaboratorAgentId,
          agentVersion: collaboratorVersion,
        },
        new Set(visited),
      );
      if (!collaborator) {
        notes.push({
          category: "collaborator-cycle",
          message:
            `Skipped collaborator '${summary.collaboratorName}' because it creates a cycle at ` +
            `${collaboratorAgentId}:${collaboratorVersion}.`,
        });
        continue;
      }

      collaborators.push({
        name: summary.collaboratorName,
        instruction: summary.collaborationInstruction,
        relayConversationHistory: summary.relayConversationHistory,
        agent: collaborator,
      });
    }
    return collaborators;
  }
}

// Only ORCHESTRATION inference settings carry over: that is the prompt the generated agent
// actually runs. Pre/post-processing and knowledge-base prompt types have no equivalent in a
// single-model Strands/LangGraph agent, so their settings are reported as manual follow-up instead.
//
// The OVERRIDDEN gate matters: Bedrock echoes its own internal orchestration defaults (for
// example temperature 1 and a '</answer>' stop sequence) even when the customer never set them,
// and copying those into a plain Strands/LangGraph agent changes its behavior for the worse.
function orchestrationInference(
  agentVersion: AgentVersion,
): ImportedInferenceConfiguration | undefined {
  const inference = (agentVersion.promptOverrideConfiguration?.promptConfigurations ?? []).find(
    (prompt) => prompt.promptType === "ORCHESTRATION" && prompt.promptCreationMode === "OVERRIDDEN",
  )?.inferenceConfiguration;
  if (!inference) return undefined;

  const configuration: ImportedInferenceConfiguration = {
    ...(inference.temperature !== undefined && { temperature: inference.temperature }),
    ...(inference.topP !== undefined && { topP: inference.topP }),
    ...(inference.topK !== undefined && { topK: inference.topK }),
    ...(inference.maximumLength !== undefined && { maximumLength: inference.maximumLength }),
    ...(inference.stopSequences !== undefined && { stopSequences: inference.stopSequences }),
  };
  return Object.keys(configuration).length > 0 ? configuration : undefined;
}

function hasPromptOverrides(agentVersion: AgentVersion): boolean {
  const configuration = agentVersion.promptOverrideConfiguration;
  return (
    configuration?.overrideLambda !== undefined ||
    // Only an explicit OVERRIDDEN mode means the customer customized anything. Bedrock populates
    // additionalModelRequestFields on the ORCHESTRATION prompt of even a fully default agent, so
    // its presence is not evidence of customization and would raise a note about nothing.
    (configuration?.promptConfigurations ?? []).some(
      (prompt) =>
        prompt.promptState !== "DISABLED" &&
        (prompt.promptCreationMode === "OVERRIDDEN" || prompt.parserMode === "OVERRIDDEN"),
    )
  );
}

function normalizeActionGroup(
  actionGroup: AgentActionGroup | undefined,
  expected: { agentId: string; agentVersion: string; actionGroupId: string },
): ImportedActionGroup {
  if (
    !actionGroup ||
    actionGroup.agentId !== expected.agentId ||
    actionGroup.agentVersion !== expected.agentVersion ||
    actionGroup.actionGroupId !== expected.actionGroupId ||
    !actionGroup.actionGroupName
  ) {
    throw new MalformedServiceResponseError(
      `the Bedrock Agent service returned an incomplete action group ` +
        `'${expected.actionGroupId}' for agent '${expected.agentId}' version ` +
        `'${expected.agentVersion}'`,
    );
  }

  const functionSchema =
    actionGroup.functionSchema && "functions" in actionGroup.functionSchema
      ? actionGroup.functionSchema.functions
      : undefined;
  const executor = actionGroup.actionGroupExecutor;

  return {
    name: actionGroup.actionGroupName,
    description: actionGroup.description,
    parentActionSignature: actionGroup.parentActionSignature,
    functions: (functionSchema ?? []).flatMap((fn) =>
      fn.name
        ? [
            {
              name: fn.name,
              description: fn.description,
              parameters: Object.fromEntries(
                Object.entries(fn.parameters ?? {}).map(([name, parameter]) => [
                  name,
                  {
                    type: parameter.type ?? "string",
                    description: parameter.description,
                    required: parameter.required ?? false,
                  },
                ]),
              ),
            },
          ]
        : [],
    ),
    hasApiSchema: actionGroup.apiSchema !== undefined,
    hasLambdaExecutor: !!executor && "lambda" in executor && !!executor.lambda,
    returnsControl:
      !!executor && "customControl" in executor && executor.customControl === "RETURN_CONTROL",
  };
}

function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
