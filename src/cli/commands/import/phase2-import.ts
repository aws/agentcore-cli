import { getCredentialProvider } from '../../aws/account';
import type { CfnTemplate } from './template-utils';
import { buildImportTemplate } from './template-utils';
import type { ResourceToImport } from './types';
import {
  type ResourceToImport as CfnResourceToImport,
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from '@aws-sdk/client-cloudformation';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Phase2Options {
  region: string;
  stackName: string;
  deployedTemplate: CfnTemplate;
  synthTemplate: CfnTemplate;
  resourcesToImport: ResourceToImport[];
  assemblyDirectory: string;
  onProgress?: (message: string) => void;
}

export interface Phase2Result {
  success: boolean;
  error?: string;
}

/**
 * Phase 2: IMPORT
 *
 * Uses CloudFormation's IMPORT change set mechanism to bring pre-existing
 * resources under stack management.
 *
 * Three strict restrictions:
 * 1. Cannot create new resources outside ResourcesToImport
 * 2. Cannot update existing resources in the stack
 * 3. Cannot add or modify Outputs
 */
export async function executePhase2(options: Phase2Options): Promise<Phase2Result> {
  const { region, stackName, deployedTemplate, synthTemplate, resourcesToImport, assemblyDirectory, onProgress } =
    options;

  if (resourcesToImport.length === 0) {
    onProgress?.('No resources to import');
    return { success: true };
  }

  const credentials = getCredentialProvider();
  const cfn = new CloudFormationClient({ region, credentials });

  // Publish CDK assets to S3 before creating the import change set
  onProgress?.('Publishing CDK assets to S3...');
  await publishCdkAssets(assemblyDirectory, region, onProgress);

  // Build import template: deployed template + primary resources with DeletionPolicy: Retain
  const logicalIds = resourcesToImport.map(r => r.logicalResourceId);
  const importTemplate = buildImportTemplate(deployedTemplate, synthTemplate, logicalIds);
  const templateBody = JSON.stringify(importTemplate);

  // Map to CloudFormation's ResourcesToImport format
  const cfnResourcesToImport: CfnResourceToImport[] = resourcesToImport.map(r => ({
    ResourceType: r.resourceType,
    LogicalResourceId: r.logicalResourceId,
    ResourceIdentifier: r.resourceIdentifier,
  }));

  const changeSetName = `import-${Date.now()}`;

  onProgress?.(`Creating IMPORT change set: ${changeSetName}`);

  try {
    // Create the import change set
    await cfn.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: 'IMPORT',
        TemplateBody: templateBody,
        ResourcesToImport: cfnResourcesToImport,
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      })
    );

    // Wait for the change set to be created
    onProgress?.('Waiting for change set to be created...');
    await waitForChangeSetReady(cfn, stackName, changeSetName);

    // Describe the change set to see what it will do
    const changeSetDescription = await cfn.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
      })
    );

    onProgress?.(`Change set has ${changeSetDescription.Changes?.length ?? 0} changes. Executing...`);

    // Execute the change set
    await cfn.send(
      new ExecuteChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
      })
    );

    // Wait for import to complete
    onProgress?.('Waiting for IMPORT to complete...');
    await waitForStackImportComplete(cfn, stackName);

    onProgress?.('Phase 2 IMPORT complete');
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Import change set failed: ${message}` };
  }
}

/**
 * Wait for a change set to be in CREATE_COMPLETE status.
 */
async function waitForChangeSetReady(
  cfn: CloudFormationClient,
  stackName: string,
  changeSetName: string
): Promise<void> {
  const maxAttempts = 60;
  const delay = 5000; // 5 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await cfn.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
      })
    );

    const status = response.Status;

    if (status === 'CREATE_COMPLETE') {
      return;
    }

    if (status === 'FAILED') {
      throw new Error(`Change set creation failed: ${response.StatusReason ?? 'Unknown reason'}`);
    }

    // CREATE_PENDING, CREATE_IN_PROGRESS — keep waiting
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error('Timed out waiting for change set creation');
}

/**
 * Wait for stack to reach IMPORT_COMPLETE status.
 */
async function waitForStackImportComplete(cfn: CloudFormationClient, stackName: string): Promise<void> {
  const maxAttempts = 120;
  const delay = 5000; // 5 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];

    if (!stack) {
      throw new Error(`Stack ${stackName} not found during import wait`);
    }

    const status = stack.StackStatus ?? '';

    if (status === 'IMPORT_COMPLETE') {
      return;
    }

    if (status.includes('FAILED') || status.includes('ROLLBACK')) {
      throw new Error(`Import failed with status: ${status}. Reason: ${stack.StackStatusReason ?? 'Unknown'}`);
    }

    // IMPORT_IN_PROGRESS — keep waiting
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error('Timed out waiting for import to complete');
}

/**
 * Publish CDK file assets (code zips, templates) to the bootstrap S3 bucket.
 * Reads the assets manifest from the CDK assembly directory.
 */
export async function publishCdkAssets(
  assemblyDirectory: string,
  region: string,
  onProgress?: (message: string) => void
): Promise<void> {
  // Find the assets manifest
  const manifestFiles = fs.readdirSync(assemblyDirectory).filter(f => f.endsWith('.assets.json'));
  if (manifestFiles.length === 0) {
    onProgress?.('No assets manifest found, skipping asset publishing');
    return;
  }

  for (const manifestFile of manifestFiles) {
    const manifest = JSON.parse(fs.readFileSync(path.join(assemblyDirectory, manifestFile), 'utf-8')) as {
      files?: Record<
        string,
        {
          source: { path: string; packaging: string };
          destinations: Record<
            string,
            {
              bucketName: string;
              objectKey: string;
              region: string;
              assumeRoleArn?: string;
            }
          >;
        }
      >;
    };

    if (!manifest.files) continue;

    for (const [_assetHash, asset] of Object.entries(manifest.files)) {
      const sourcePath = path.join(assemblyDirectory, asset.source.path);
      if (!fs.existsSync(sourcePath)) {
        onProgress?.(`Asset file not found: ${asset.source.path}, skipping`);
        continue;
      }

      // Determine the file body to upload
      let body: Buffer;
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        if (asset.source.packaging === 'zip') {
          // Zip the directory contents
          const zipPath = `${sourcePath}.zip`;
          execSync(`cd "${sourcePath}" && zip -rq "${zipPath}" .`);
          body = fs.readFileSync(zipPath);
          fs.unlinkSync(zipPath);
        } else {
          // Skip directory assets that aren't zip packaging (e.g. Docker image contexts)
          onProgress?.(`Skipping directory asset: ${asset.source.path} (packaging: ${asset.source.packaging})`);
          continue;
        }
      } else {
        body = fs.readFileSync(sourcePath);
      }

      for (const dest of Object.values(asset.destinations)) {
        const destRegion = dest.region || region;

        // Get credentials — try assuming the publishing role if specified
        let s3Credentials = getCredentialProvider();
        if (dest.assumeRoleArn && !dest.assumeRoleArn.includes('${')) {
          try {
            const sts = new STSClient({ region: destRegion, credentials: getCredentialProvider() });
            const assumed = await sts.send(
              new AssumeRoleCommand({
                RoleArn: dest.assumeRoleArn,
                RoleSessionName: 'agentcore-import-publish',
              })
            );
            if (assumed.Credentials) {
              /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
              s3Credentials = {
                accessKeyId: assumed.Credentials.AccessKeyId!,
                secretAccessKey: assumed.Credentials.SecretAccessKey!,
                sessionToken: assumed.Credentials.SessionToken,
              } as any;
              /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
            }
          } catch {
            // Fall back to default credentials if role assumption fails
          }
        }

        const s3 = new S3Client({ region: destRegion, credentials: s3Credentials });

        onProgress?.(`Uploading ${asset.source.path} → s3://${dest.bucketName}/${dest.objectKey}`);
        await s3.send(
          new PutObjectCommand({
            Bucket: dest.bucketName,
            Key: dest.objectKey,
            Body: body,
          })
        );
      }
    }
  }
}
