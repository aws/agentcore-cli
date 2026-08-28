import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type {
  CreateCloudFormationClient,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "./types";

// createControlClient / createDataClient are the production factories injected
// into CoreClient at the app edge (src/index.ts). They live here — rather than
// inline in index.ts — so tests (the record/replay fixture layer) can reuse the
// exact same construction when talking to the live APIs in record mode.

export const createControlClient: CreateControlClient = (config) =>
  new BedrockAgentCoreControlClient({ ...config });

export const createDataClient: CreateDataClient = (config) =>
  new BedrockAgentCoreClient({ ...config });

export const createIamClient: CreateIamClient = (config) => new IAMClient({ ...config });

export const createLogsClient: CreateLogsClient = (config) =>
  new CloudWatchLogsClient({ ...config });

export const createCloudFormationClient: CreateCloudFormationClient = (config) =>
  new CloudFormationClient({ ...config });
