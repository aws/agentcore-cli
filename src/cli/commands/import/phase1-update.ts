import { getCredentialProvider } from '../../aws/account';
import type { CfnTemplate } from './template-utils';
import { filterCompanionOnlyTemplate } from './template-utils';
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';

export interface Phase1Options {
  region: string;
  stackName: string;
  synthTemplate: CfnTemplate;
  onProgress?: (message: string) => void;
}

export interface Phase1Result {
  success: boolean;
  stackExists: boolean;
  error?: string;
}

/**
 * Phase 1: UPDATE (pre-import)
 *
 * Creates companion resources (IAM roles, policies) that the imported primary
 * resources will reference. This is done by deploying a filtered template that
 * includes only companion resources (no AWS::BedrockAgentCore::* resources).
 */
export async function executePhase1(options: Phase1Options): Promise<Phase1Result> {
  const { region, stackName, synthTemplate, onProgress } = options;

  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });

  // Filter template to companion-only
  const companionTemplate = filterCompanionOnlyTemplate(synthTemplate);

  // Check if the companion template has any resources at all
  if (Object.keys(companionTemplate.Resources).length === 0) {
    onProgress?.('No companion resources needed, skipping Phase 1');
    // Still need to check if stack exists
    const stackExists = await doesStackExist(cfn, stackName);
    return { success: true, stackExists };
  }

  const templateBody = JSON.stringify(companionTemplate);

  // Check if stack already exists
  const stackExists = await doesStackExist(cfn, stackName);

  if (stackExists) {
    // When updating, preserve any primary resources that were already imported
    // into the stack. filterCompanionOnlyTemplate strips all primary resources,
    // but previously imported ones must be kept or CFN will try to delete them.
    const deployedTemplate = await getDeployedTemplate(region, stackName);
    if (deployedTemplate) {
      for (const [logicalId, resource] of Object.entries(deployedTemplate.Resources)) {
        if (!(logicalId in companionTemplate.Resources)) {
          companionTemplate.Resources[logicalId] = resource;
        }
      }
    }
    const updateTemplateBody = JSON.stringify(companionTemplate);

    onProgress?.(`Updating stack ${stackName} with companion resources...`);
    try {
      await cfn.send(
        new UpdateStackCommand({
          StackName: stackName,
          TemplateBody: updateTemplateBody,
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
        })
      );

      onProgress?.('Waiting for stack update to complete...');
      await waitUntilStackUpdateComplete(
        { client: cfn, maxWaitTime: 600, minDelay: 5, maxDelay: 15 },
        { StackName: stackName }
      );
      onProgress?.('Phase 1 UPDATE complete');
    } catch (err: unknown) {
      // "No updates are to be performed" is not an error
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('No updates are to be performed')) {
        onProgress?.('Stack already has companion resources, no update needed');
        return { success: true, stackExists: true };
      }
      return { success: false, stackExists: true, error: message };
    }
  } else {
    onProgress?.(`Creating stack ${stackName} with companion resources...`);
    try {
      await cfn.send(
        new CreateStackCommand({
          StackName: stackName,
          TemplateBody: templateBody,
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
          Tags: [
            { Key: 'agentcore:project-name', Value: stackName.replace(/^AgentCore-/, '').replace(/-[^-]+$/, '') },
            { Key: 'agentcore:target-name', Value: 'default' },
          ],
        })
      );

      onProgress?.('Waiting for stack creation to complete...');
      await waitUntilStackCreateComplete(
        { client: cfn, maxWaitTime: 600, minDelay: 5, maxDelay: 15 },
        { StackName: stackName }
      );
      onProgress?.('Phase 1 CREATE complete');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, stackExists: false, error: message };
    }
  }

  return { success: true, stackExists };
}

/**
 * Get the currently deployed CloudFormation template.
 */
export async function getDeployedTemplate(region: string, stackName: string): Promise<CfnTemplate | null> {
  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });

  try {
    const response = await cfn.send(
      new GetTemplateCommand({
        StackName: stackName,
        TemplateStage: 'Original',
      })
    );

    if (response.TemplateBody) {
      return JSON.parse(response.TemplateBody) as CfnTemplate;
    }
    return null;
  } catch {
    return null;
  }
}

async function doesStackExist(cfn: CloudFormationClient, stackName: string): Promise<boolean> {
  try {
    const response = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];
    return !!stack && stack.StackStatus !== 'DELETE_COMPLETE';
  } catch {
    return false;
  }
}
