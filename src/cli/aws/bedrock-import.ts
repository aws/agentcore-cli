/**
 * AWS SDK v3 wrapper for fetching Bedrock Agent configurations.
 * Port of the starter toolkit's agent_info.py.
 */
import { getCredentialProvider } from './account';
import type {
  ActionGroupInfo,
  BedrockAgentConfig,
  BedrockAgentInfo,
  BedrockAgentSummary,
  BedrockAliasSummary,
  CollaboratorInfo,
  KnowledgeBaseInfo,
} from './bedrock-import-types';
import { BedrockClient, GetFoundationModelCommand, GetGuardrailCommand } from '@aws-sdk/client-bedrock';
import {
  BedrockAgentClient,
  GetAgentActionGroupCommand,
  GetAgentAliasCommand,
  GetAgentCommand,
  GetKnowledgeBaseCommand,
  ListAgentActionGroupsCommand,
  ListAgentAliasesCommand,
  ListAgentCollaboratorsCommand,
  ListAgentKnowledgeBasesCommand,
  ListAgentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import yaml from 'js-yaml';

function createBedrockAgentClient(region: string): BedrockAgentClient {
  return new BedrockAgentClient({ credentials: getCredentialProvider(), region });
}

function createBedrockClient(region: string): BedrockClient {
  return new BedrockClient({ credentials: getCredentialProvider(), region });
}

function createS3Client(region: string): S3Client {
  return new S3Client({ credentials: getCredentialProvider(), region });
}

/**
 * Clean a variable name to be Python-safe (matches starter toolkit's clean_variable_name).
 */
function cleanVariableName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * List all Bedrock Agents in a region.
 */
export async function listBedrockAgents(region: string): Promise<BedrockAgentSummary[]> {
  const client = createBedrockAgentClient(region);
  const agents: BedrockAgentSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListAgentsCommand({ maxResults: 200, nextToken }));
    for (const agent of response.agentSummaries ?? []) {
      agents.push({
        agentId: agent.agentId ?? '',
        agentName: agent.agentName ?? '',
        description: agent.description ?? '',
      });
    }
    nextToken = response.nextToken;
  } while (nextToken);
  return agents;
}

/**
 * List all aliases for a specific Bedrock Agent.
 */
export async function listBedrockAgentAliases(region: string, agentId: string): Promise<BedrockAliasSummary[]> {
  const client = createBedrockAgentClient(region);
  const aliases: BedrockAliasSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListAgentAliasesCommand({ agentId, nextToken }));
    for (const alias of response.agentAliasSummaries ?? []) {
      aliases.push({
        aliasId: alias.agentAliasId ?? '',
        aliasName: alias.agentAliasName ?? '',
        description: alias.description ?? '',
      });
    }
    nextToken = response.nextToken;
  } while (nextToken);
  return aliases;
}

/**
 * Recursively fetch full Bedrock Agent configuration including action groups,
 * knowledge bases, and collaborators. Port of agent_info.py's get_agent_info().
 */
export async function getBedrockAgentConfig(
  region: string,
  agentId: string,
  aliasId: string,
  visitedAgents: Set<string> = new Set<string>()
): Promise<BedrockAgentConfig> {
  const visitKey = `${agentId}:${aliasId}`;
  if (visitedAgents.has(visitKey)) {
    return { agent: {} as BedrockAgentInfo, action_groups: [], knowledge_bases: [], collaborators: [] };
  }
  visitedAgents.add(visitKey);
  const agentClient = createBedrockAgentClient(region);
  const bedrockClient = createBedrockClient(region);

  // Get agent version from alias
  const aliasResponse = await agentClient.send(new GetAgentAliasCommand({ agentId, agentAliasId: aliasId }));
  const agentVersion = aliasResponse.agentAlias?.routingConfiguration?.[0]?.agentVersion ?? 'DRAFT';

  // Get agent info
  const agentResponse = await agentClient.send(new GetAgentCommand({ agentId }));
  const agentInfo = agentResponse.agent as unknown as BedrockAgentInfo;

  // Filter prompt configurations to only enabled ones
  if (agentInfo.orchestrationType === 'DEFAULT' && agentInfo.promptOverrideConfiguration?.promptConfigurations) {
    agentInfo.promptOverrideConfiguration.promptConfigurations =
      agentInfo.promptOverrideConfiguration.promptConfigurations.filter(c => c.promptState === 'ENABLED');
  }

  // Get guardrail details if configured
  const guardrailIdentifier = agentInfo.guardrailConfiguration?.guardrailIdentifier;
  const guardrailVersion = agentInfo.guardrailConfiguration?.guardrailVersion;
  if (guardrailIdentifier && guardrailVersion) {
    try {
      const guardrailResponse = await bedrockClient.send(
        new GetGuardrailCommand({
          guardrailIdentifier,
          guardrailVersion,
        })
      );
      agentInfo.guardrailConfiguration = {
        guardrailId: guardrailResponse.guardrailId,
        guardrailVersion: guardrailResponse.version,
      } as unknown as typeof agentInfo.guardrailConfiguration;
    } catch (err) {
      console.warn(`Warning: Failed to fetch guardrail details: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Get model info
  try {
    const modelInferenceProfile = agentInfo.foundationModel.split('/').pop() ?? agentInfo.foundationModel;
    const modelIdParts = modelInferenceProfile.split('.');
    const modelId = modelIdParts.length >= 2 ? modelIdParts.slice(-2).join('.') : modelInferenceProfile;
    const modelResponse = await bedrockClient.send(new GetFoundationModelCommand({ modelIdentifier: modelId }));
    agentInfo.model = {
      modelId: modelResponse.modelDetails?.modelId,
      modelName: modelResponse.modelDetails?.modelName,
      providerName: modelResponse.modelDetails?.providerName,
    };
  } catch (err) {
    console.warn(`Warning: Failed to fetch model info: ${err instanceof Error ? err.message : String(err)}`);
    agentInfo.model = { providerName: 'anthropic' };
  }

  agentInfo.alias = aliasId;
  agentInfo.version = agentVersion;

  // Get action groups
  const actionGroups = await fetchActionGroups(agentClient, region, agentId, agentVersion);

  // Get knowledge bases
  const knowledgeBases = await fetchKnowledgeBases(agentClient, agentId, agentVersion);

  // Get collaborators
  const collaborators = await fetchCollaborators(
    agentClient,
    bedrockClient,
    region,
    agentId,
    agentVersion,
    aliasId,
    agentInfo,
    visitedAgents
  );

  return {
    agent: agentInfo,
    action_groups: actionGroups,
    knowledge_bases: knowledgeBases,
    collaborators,
  };
}

async function fetchActionGroups(
  client: BedrockAgentClient,
  region: string,
  agentId: string,
  agentVersion: string
): Promise<ActionGroupInfo[]> {
  const summaries: { actionGroupId?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const listResponse = await client.send(new ListAgentActionGroupsCommand({ agentId, agentVersion, nextToken }));
    summaries.push(...(listResponse.actionGroupSummaries ?? []));
    nextToken = listResponse.nextToken;
  } while (nextToken);

  const actionGroups: ActionGroupInfo[] = [];

  for (const summary of summaries) {
    if (!summary.actionGroupId) continue;
    const detail = await client.send(
      new GetAgentActionGroupCommand({
        agentId,
        agentVersion,
        actionGroupId: summary.actionGroupId,
      })
    );
    const ag = detail.agentActionGroup as unknown as ActionGroupInfo;
    ag.actionGroupName = cleanVariableName(ag.actionGroupName);

    // Resolve API schema if present
    if (ag.apiSchema) {
      const payload = (ag.apiSchema as Record<string, unknown>).payload;
      if (typeof payload === 'string') {
        // Inline YAML/JSON schema
        try {
          ag.apiSchema.payload = yaml.load(payload) as Record<string, unknown>;
        } catch (err) {
          console.warn(`Warning: Failed to parse API schema: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (ag.apiSchema.s3) {
        // S3-stored schema
        try {
          const s3Client = createS3Client(region);
          const s3Response = await s3Client.send(
            new GetObjectCommand({
              Bucket: ag.apiSchema.s3.s3BucketName,
              Key: ag.apiSchema.s3.s3ObjectKey,
            })
          );
          const body = await s3Response.Body?.transformToString();
          if (body) {
            ag.apiSchema.payload = yaml.load(body) as Record<string, unknown>;
          }
        } catch (err) {
          console.warn(`Warning: Failed to fetch S3 schema: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    actionGroups.push(ag);
  }

  return actionGroups;
}

async function fetchKnowledgeBases(
  client: BedrockAgentClient,
  agentId: string,
  agentVersion: string
): Promise<KnowledgeBaseInfo[]> {
  const summaries: { knowledgeBaseId?: string; knowledgeBaseState?: string; description?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const listResponse = await client.send(new ListAgentKnowledgeBasesCommand({ agentId, agentVersion, nextToken }));
    summaries.push(...(listResponse.agentKnowledgeBaseSummaries ?? []));
    nextToken = listResponse.nextToken;
  } while (nextToken);

  const knowledgeBases: KnowledgeBaseInfo[] = [];

  for (const summary of summaries) {
    if (!summary.knowledgeBaseId) continue;
    try {
      const kbDetail = await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: summary.knowledgeBaseId }));
      const kb = kbDetail.knowledgeBase;
      knowledgeBases.push({
        knowledgeBaseId: summary.knowledgeBaseId,
        knowledgeBaseState: summary.knowledgeBaseState ?? 'ENABLED',
        description: summary.description ?? kb?.description ?? '',
        name: cleanVariableName(kb?.name ?? summary.knowledgeBaseId),
        knowledgeBaseArn: kb?.knowledgeBaseArn,
      });
    } catch (err) {
      console.warn(
        `Warning: Failed to fetch knowledge base ${summary.knowledgeBaseId}: ${err instanceof Error ? err.message : String(err)}`
      );
      knowledgeBases.push({
        knowledgeBaseId: summary.knowledgeBaseId,
        knowledgeBaseState: summary.knowledgeBaseState ?? 'ENABLED',
        description: summary.description ?? '',
      });
    }
  }

  return knowledgeBases;
}

async function fetchCollaborators(
  agentClient: BedrockAgentClient,
  bedrockClient: BedrockClient,
  region: string,
  agentId: string,
  agentVersion: string,
  aliasId: string,
  agentInfo: BedrockAgentInfo,
  visitedAgents: Set<string>
): Promise<CollaboratorInfo[]> {
  if (agentInfo.agentCollaboration === 'DISABLED' || !agentInfo.agentCollaboration) {
    return [];
  }

  try {
    const summaries: unknown[] = [];
    let nextToken: string | undefined;
    do {
      const listResponse = await agentClient.send(
        new ListAgentCollaboratorsCommand({ agentId, agentVersion, nextToken })
      );
      summaries.push(...(listResponse.agentCollaboratorSummaries ?? []));
      nextToken = listResponse.nextToken;
    } while (nextToken);

    const collaborators: CollaboratorInfo[] = [];

    for (const summary of summaries) {
      const aliasArn = (summary as { agentDescriptor?: { aliasArn?: string } }).agentDescriptor?.aliasArn;
      if (!aliasArn) continue;

      const arnMatch = /^arn:aws:bedrock:[^:]+:[^:]+:agent-alias\/([^/]+)\/([^/]+)$/.exec(aliasArn);
      if (!arnMatch) continue;
      const [, collabAgentId, collabAliasId] = arnMatch;
      if (!collabAgentId || !collabAliasId) continue;

      // Recursively fetch collaborator config (passing visited set to prevent cycles)
      const collabConfig = await getBedrockAgentConfig(region, collabAgentId, collabAliasId, visitedAgents);
      const collabInfo: CollaboratorInfo = {
        ...collabConfig,
        collaboratorName: cleanVariableName((summary as { collaboratorName?: string }).collaboratorName ?? ''),
        collaborationInstruction: (summary as { collaborationInstruction?: string }).collaborationInstruction ?? '',
        relayConversationHistory:
          (summary as { relayConversationHistory?: string }).relayConversationHistory ?? 'DISABLED',
      };
      collaborators.push(collabInfo);
    }

    if (collaborators.length > 0) {
      agentInfo.isPrimaryAgent = true;
      agentInfo.collaborators = summaries;
    }

    return collaborators;
  } catch (err) {
    console.warn(`Warning: Failed to fetch collaborators: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
