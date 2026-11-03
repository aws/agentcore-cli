import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { XRayClient } from "@aws-sdk/client-xray";
import { ApplicationSignalsClient } from "@aws-sdk/client-application-signals";
import { HttpBearerAuthSigner } from "@smithy/core";
import type { TokenIdentity } from "@smithy/types";
import type {
  CreateApplicationSignalsClient,
  CreateCloudFormationClient,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
  CreateXrayClient,
} from "./types";

// createControlClient / createDataClient are the production factories injected
// into CoreClient at the app edge (src/index.ts). They live here — rather than
// inline in index.ts — so tests (the record/replay fixture layer) can reuse the
// exact same construction when talking to the live APIs in record mode.

export const createControlClient: CreateControlClient = (config) =>
  new BedrockAgentCoreControlClient({ ...config });

// A bearer token swaps SigV4 for Smithy's HTTP bearer auth scheme, so the client
// sends `Authorization: Bearer <token>` and never resolves AWS credentials.
export const createDataClient: CreateDataClient = ({ bearerToken, ...config }) =>
  new BedrockAgentCoreClient({
    ...config,
    ...(bearerToken !== undefined && {
      httpAuthSchemes: [
        {
          schemeId: "smithy.api#httpBearerAuth",
          identityProvider: () => async (): Promise<TokenIdentity> => ({ token: bearerToken }),
          signer: new HttpBearerAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: "smithy.api#httpBearerAuth" }],
    }),
  });

export const createIamClient: CreateIamClient = (config) => new IAMClient({ ...config });

export const createLogsClient: CreateLogsClient = (config) =>
  new CloudWatchLogsClient({ ...config });

export const createXrayClient: CreateXrayClient = (config) => new XRayClient({ ...config });

export const createApplicationSignalsClient: CreateApplicationSignalsClient = (config) =>
  new ApplicationSignalsClient({ ...config });

export const createCloudFormationClient: CreateCloudFormationClient = (config) =>
  new CloudFormationClient({ ...config });
