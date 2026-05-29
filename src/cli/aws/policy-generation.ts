import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreControlClient,
  GetPolicyGenerationCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
  waitUntilPolicyGenerationCompleted,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { WaiterState } from '@smithy/util-waiter';

export interface StartPolicyGenerationOptions {
  policyEngineId: string;
  description: string;
  region: string;
  resourceArn: string;
}

export interface StartPolicyGenerationResult {
  generationId: string;
}

export interface GetPolicyGenerationOptions {
  generationId: string;
  policyEngineId: string;
  region: string;
}

export interface GetPolicyGenerationResult {
  status: string;
  statement: string;
}

export async function startPolicyGeneration(
  options: StartPolicyGenerationOptions
): Promise<StartPolicyGenerationResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new StartPolicyGenerationCommand({
    policyEngineId: options.policyEngineId,
    resource: { arn: options.resourceArn },
    content: {
      rawText: options.description,
    },
    name: `cli_generation_${Date.now()}`,
  });

  const response = await client.send(command);

  if (!response.policyGenerationId) {
    throw new Error('No generation ID returned from StartPolicyGeneration');
  }

  return { generationId: response.policyGenerationId };
}

export async function getPolicyGeneration(options: GetPolicyGenerationOptions): Promise<GetPolicyGenerationResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  // Use the SDK waiter to poll until generation completes
  const waiterResult = await waitUntilPolicyGenerationCompleted(
    { client, maxWaitTime: 120, minDelay: 2, maxDelay: 5 },
    { policyGenerationId: options.generationId, policyEngineId: options.policyEngineId }
  );

  if (waiterResult.state !== WaiterState.SUCCESS) {
    throw new Error(
      `Policy generation did not complete within the timeout period (state: ${waiterResult.state}). ` +
        `Generation ID: ${options.generationId}`
    );
  }

  // Check the final status
  const getCommand = new GetPolicyGenerationCommand({
    policyGenerationId: options.generationId,
    policyEngineId: options.policyEngineId,
  });

  const statusResponse = await client.send(getCommand);

  if (statusResponse.status === 'GENERATE_FAILED') {
    const reasons = statusResponse.statusReasons?.join(', ') ?? 'Unknown reason';
    throw new Error(`Policy generation failed: ${reasons}`);
  }

  // Fetch the generated assets
  const assetsCommand = new ListPolicyGenerationAssetsCommand({
    policyGenerationId: options.generationId,
    policyEngineId: options.policyEngineId,
  });

  const assetsResponse = await client.send(assetsCommand);
  const assets = assetsResponse.policyGenerationAssets ?? [];

  if (assets.length === 0) {
    throw new Error('Policy generation completed but no assets were returned');
  }

  // Get the Cedar statement from the first asset
  const firstAsset = assets[0]!;
  const cedarStatement = firstAsset.definition?.cedar?.statement;

  if (!cedarStatement) {
    throw new Error('Policy generation completed but no Cedar policy statement was found in the assets');
  }

  return {
    status: statusResponse.status ?? 'GENERATED',
    statement: cedarStatement,
  };
}
