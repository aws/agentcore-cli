import type { AgentCoreProjectSpec, AuthorizerConfig, RuntimeAuthorizerType } from '../../../schema';

/**
 * Parsed representation of a starter toolkit agent from .bedrock_agentcore.yaml.
 */
export interface ParsedStarterToolkitAgent {
  name: string;
  entrypoint: string;
  build: 'CodeZip' | 'Container';
  runtimeVersion?: string;
  language: 'python' | 'typescript';
  sourcePath?: string;
  networkMode: 'PUBLIC' | 'VPC';
  networkConfig?: { subnets: string[]; securityGroups: string[] };
  protocol: 'HTTP' | 'MCP' | 'A2A';
  enableOtel: boolean;
  /** Physical agent runtime ID from the starter toolkit deployment */
  physicalAgentId?: string;
  /** Physical agent runtime ARN */
  physicalAgentArn?: string;
  /** Authorizer type for inbound requests */
  authorizerType?: RuntimeAuthorizerType;
  /** Authorizer configuration (Custom JWT) */
  authorizerConfiguration?: AuthorizerConfig;
}

/**
 * Parsed representation of a starter toolkit memory config.
 */
export interface ParsedStarterToolkitMemory {
  name: string;
  mode: 'STM_ONLY' | 'STM_AND_LTM' | 'NO_MEMORY';
  eventExpiryDays: number;
  /** Physical memory ID from the starter toolkit deployment */
  physicalMemoryId?: string;
  /** Physical memory ARN */
  physicalMemoryArn?: string;
}

/**
 * Parsed representation of a starter toolkit credential provider.
 */
export interface ParsedStarterToolkitCredential {
  /** Credential provider name in Identity service */
  name: string;
  /** Provider type: cognito, github, google, salesforce, or api_key */
  providerType: 'oauth' | 'api_key';
}

/**
 * Full parsed result from the YAML file.
 */
export interface ParsedStarterToolkitConfig {
  defaultAgent?: string;
  agents: ParsedStarterToolkitAgent[];
  memories: ParsedStarterToolkitMemory[];
  credentials: ParsedStarterToolkitCredential[];
  awsTarget: {
    account?: string;
    region?: string;
  };
}

/**
 * Resource to be imported via CloudFormation IMPORT change set.
 */
export interface ResourceToImport {
  resourceType: string;
  logicalResourceId: string;
  resourceIdentifier: Record<string, string>;
}

/**
 * Result of the import command.
 */
export interface ImportResult {
  success: boolean;
  error?: string;
  projectSpec?: AgentCoreProjectSpec;
  importedAgents?: string[];
  importedMemories?: string[];
  stackName?: string;
  logPath?: string;
}
