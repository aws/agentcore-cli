import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

// CoreOptions is the standard trailing argument for Core operations. It carries
// the per-call settings a handler resolves from context (the AWS region and an
// optional endpoint URL override) and is translated into a ClientConfig by the
// sub-clients.
export interface CoreOptions {
  region: string;
  endpointUrl?: string;
}

// ClientConfig is the per-request configuration handed to the client factories. It
// is spread directly into the SDK client constructor, so its fields mirror the
// SDK's own option names (e.g. `endpoint` for a custom endpoint URL).
export interface ClientConfig {
  region: string;
  endpoint?: string;
}

// Factories construct an SDK client from a ClientConfig. Injecting these (rather
// than the clients themselves) lets CoreClient create/cache one client per config
// while keeping construction swappable for unit tests.
export type CreateControlClient = (config: ClientConfig) => BedrockAgentCoreControlClient;
export type CreateDataClient = (config: ClientConfig) => BedrockAgentCoreClient;
export type CreateIamClient = (config: ClientConfig) => IAMClient;
export type CreateLogsClient = (config: ClientConfig) => CloudWatchLogsClient;
export type CoreFetch = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

// AwsClients hands out configured SDK clients. CoreClient implements it and its
// sub-clients (HarnessClient, etc.) consume it, so they all share the same
// cached connections rather than constructing their own. Both accessors take a
// full ClientConfig so callers can request any client customization (region,
// endpoint, ...).
export interface AwsClients {
  control(config: ClientConfig): BedrockAgentCoreControlClient;
  data(config: ClientConfig): BedrockAgentCoreClient;
  iam(config: ClientConfig): IAMClient;
  // logs reads the CloudWatch Logs streams AgentCore writes batch-evaluation
  // results to. CloudWatch is a distinct service from the AgentCore data plane,
  // so it gets its own client/factory rather than reusing `data`.
  logs(config: ClientConfig): CloudWatchLogsClient;
}
