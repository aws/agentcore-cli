import { getProxyRequestHandler } from '../../lib/utils/aws-proxy';
import { getCredentialProvider } from '../aws';
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';

const TAG_PROJECT_NAME = 'agentcore:project-name';
const TAG_TARGET_NAME = 'agentcore:target-name';

export interface DiscoveredStack {
  stackName: string;
  stackArn: string;
  targetName: string;
}

/**
 * Parse stack name from a CloudFormation stack ARN.
 * ARN format: arn:aws:cloudformation:region:account:stack/STACK_NAME/STACK_ID
 * Returns null if ARN is not a valid CloudFormation stack ARN.
 */
function parseStackNameFromArn(arn: string): string | null {
  // Validate this is a CloudFormation stack ARN (not stackset or other)
  if (!arn.includes(':stack/')) {
    return null;
  }

  // Extract the stack name from the ARN path
  const stackPath = arn.split(':stack/')[1];
  if (!stackPath) {
    return null;
  }

  // Stack path is "STACK_NAME/STACK_ID" - take the name part
  const stackName = stackPath.split('/')[0];
  if (!stackName || stackName.length === 0) {
    return null;
  }

  return stackName;
}

/**
 * Discover AgentCore stacks by project name using Resource Groups Tagging API.
 * Returns all stacks tagged with the given project name.
 * Handles pagination to retrieve all matching stacks.
 */
export async function discoverStacksByProject(region: string, projectName: string): Promise<DiscoveredStack[]> {
  const tagging = new ResourceGroupsTaggingAPIClient({
    region,
    credentials: getCredentialProvider(),
    requestHandler: getProxyRequestHandler(),
  });
  const stacks: DiscoveredStack[] = [];
  let paginationToken: string | undefined;

  do {
    const response = await tagging.send(
      new GetResourcesCommand({
        TagFilters: [{ Key: TAG_PROJECT_NAME, Values: [projectName] }],
        ResourceTypeFilters: ['cloudformation:stack'],
        PaginationToken: paginationToken,
      })
    );

    for (const resource of response.ResourceTagMappingList ?? []) {
      if (!resource.ResourceARN) continue;

      const stackName = parseStackNameFromArn(resource.ResourceARN);
      if (!stackName) continue;

      // Get target name from tags
      const targetTag = resource.Tags?.find(t => t.Key === TAG_TARGET_NAME);
      const targetName = targetTag?.Value ?? 'default';

      stacks.push({
        stackName,
        stackArn: resource.ResourceARN,
        targetName,
      });
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return stacks;
}

/**
 * Find a specific stack by project and target name.
 * Returns the first matching stack, or null if none found.
 */
export async function findStack(
  region: string,
  projectName: string,
  targetName = 'default'
): Promise<DiscoveredStack | null> {
  const stacks = await discoverStacksByProject(region, projectName);
  return stacks.find(s => s.targetName === targetName) ?? null;
}

/**
 * Get stack name for a project/target, discovering via tags.
 * Returns null if no stack found.
 */
export async function getStackName(
  region: string,
  projectName: string,
  targetName = 'default'
): Promise<string | null> {
  const stack = await findStack(region, projectName, targetName);
  return stack?.stackName ?? null;
}
