/**
 * TypeScript interfaces for Bedrock Agent import configuration.
 * These represent the fetched configuration from the Bedrock Agent API,
 * used as input to the translators.
 */

export interface BedrockAgentSummary {
  agentId: string;
  agentName: string;
  description: string;
}

export interface BedrockAliasSummary {
  aliasId: string;
  aliasName: string;
  description: string;
}

export interface ActionGroupInfo {
  actionGroupId: string;
  actionGroupName: string;
  actionGroupState: string;
  description?: string;
  parentActionSignature?: string;
  actionGroupExecutor?: {
    lambda?: string;
    customControl?: string;
  };
  apiSchema?: {
    payload?: Record<string, unknown>;
    s3?: {
      s3BucketName: string;
      s3ObjectKey: string;
    };
  };
  functionSchema?: {
    functions?: FunctionDefinition[];
  };
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<
    string,
    {
      type: string;
      description?: string;
      required?: boolean;
    }
  >;
  requireConfirmation?: string;
}

export interface KnowledgeBaseInfo {
  knowledgeBaseId: string;
  knowledgeBaseState: string;
  description?: string;
  name?: string;
  knowledgeBaseArn?: string;
}

export interface CollaboratorInfo {
  agent: BedrockAgentInfo;
  action_groups: ActionGroupInfo[];
  knowledge_bases: KnowledgeBaseInfo[];
  collaborators: CollaboratorInfo[];
  collaboratorName?: string;
  collaborationInstruction?: string;
  relayConversationHistory?: string;
}

export interface GuardrailConfig {
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  guardrailId?: string;
  version?: string;
}

export interface PromptConfiguration {
  promptType: string;
  promptState: string;
  basePromptTemplate?: {
    system?: string;
  };
  inferenceConfiguration?: {
    temperature?: number;
    maximumLength?: number;
    stopSequences?: string[];
    topP?: number;
    topK?: number;
  };
}

export interface BedrockAgentInfo {
  agentId: string;
  agentName: string;
  agentArn: string;
  foundationModel: string;
  instruction?: string;
  description?: string;
  idleSessionTTLInSeconds?: number;
  orchestrationType?: string;
  agentCollaboration?: string;
  memoryConfiguration?: {
    enabledMemoryTypes?: string[];
    storageDays?: number;
  };
  promptOverrideConfiguration?: {
    promptConfigurations: PromptConfiguration[];
  };
  guardrailConfiguration?: GuardrailConfig;
  model?: {
    modelId?: string;
    modelName?: string;
    providerName?: string;
  };
  alias?: string;
  version?: string;
  isPrimaryAgent?: boolean;
  collaborators?: unknown[];
}

export interface BedrockAgentConfig {
  agent: BedrockAgentInfo;
  action_groups: ActionGroupInfo[];
  knowledge_bases: KnowledgeBaseInfo[];
  collaborators: CollaboratorInfo[];
}
