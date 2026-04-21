import type { ConfigIO } from '../../../lib';
import type { AwsDeploymentTarget } from '../../../schema';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { silentIoHost } from '../../cdk/toolkit-lib';
import { bootstrapEnvironment, buildCdkProject, checkBootstrapNeeded, synthesizeCdk } from '../../operations/deploy';
import type { ImportedResource } from './import-utils';
import { updateDeployedState } from './import-utils';
import { executePhase1, getDeployedTemplate } from './phase1-update';
import { executePhase2, publishCdkAssets } from './phase2-import';
import type { CfnTemplate } from './template-utils';
import type { ResourceToImport } from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CdkImportPipelineInput {
  projectRoot: string;
  stackName: string;
  target: AwsDeploymentTarget;
  configIO: ConfigIO;
  targetName: string;
  onProgress: (message: string) => void;

  /** Caller builds the import resource list from the synthesized template. */
  buildResourcesToImport: (synthTemplate: CfnTemplate, deployedTemplate: CfnTemplate) => ResourceToImport[];

  /** Entries to write into deployed-state.json after a successful import. */
  deployedStateEntries: ImportedResource[];
}

export interface CdkImportPipelineResult {
  success: boolean;
  error?: string;
  /** True when buildResourcesToImport returned an empty list. Callers decide if this is an error. */
  noResources?: boolean;
}

/**
 * Shared CDK import pipeline: build → synth → bootstrap → publish assets → phase 1 → phase 2 → update state.
 *
 * Callers handle resource-specific logic (AWS fetching, config mutation, name validation)
 * and delegate the CDK/CloudFormation work to this function.
 */
export async function executeCdkImportPipeline(input: CdkImportPipelineInput): Promise<CdkImportPipelineResult> {
  const {
    projectRoot,
    stackName,
    target,
    configIO,
    targetName,
    onProgress,
    buildResourcesToImport,
    deployedStateEntries,
  } = input;

  // 1. Build CDK project
  onProgress('Building CDK project...');
  const cdkProject = new LocalCdkProject(projectRoot);
  await buildCdkProject(cdkProject);

  // 2. Synthesize CloudFormation template
  onProgress('Synthesizing CloudFormation template...');
  const synthResult = await synthesizeCdk(cdkProject, { ioHost: silentIoHost });
  const { toolkitWrapper } = synthResult;

  const synthInfo = await toolkitWrapper.synth();
  const assemblyDirectory = synthInfo.assemblyDirectory;
  const synthTemplatePath = path.join(assemblyDirectory, `${stackName}.template.json`);

  let synthTemplate: CfnTemplate;
  try {
    synthTemplate = JSON.parse(fs.readFileSync(synthTemplatePath, 'utf-8')) as CfnTemplate;
  } catch {
    const files = fs.readdirSync(assemblyDirectory).filter((f: string) => f.endsWith('.template.json'));
    if (files.length === 0) {
      await toolkitWrapper.dispose();
      return { success: false, error: 'No CloudFormation template found in CDK assembly' };
    }
    synthTemplate = JSON.parse(fs.readFileSync(path.join(assemblyDirectory, files[0]!), 'utf-8')) as CfnTemplate;
  }

  // 3. Check CDK bootstrap and auto-bootstrap if needed
  onProgress('Checking CDK bootstrap status...');
  const bootstrapCheck = await checkBootstrapNeeded([target]);
  if (bootstrapCheck.needsBootstrap) {
    onProgress('Bootstrapping AWS environment...');
    await bootstrapEnvironment(toolkitWrapper, target);
    onProgress('CDK bootstrap complete');
  }

  await toolkitWrapper.dispose();

  // 4. Publish CDK assets to S3
  onProgress('Publishing CDK assets to S3...');
  await publishCdkAssets(assemblyDirectory, target.region, onProgress);

  // 5. Phase 1: Deploy companion resources
  onProgress('Phase 1: Deploying companion resources (IAM roles, policies)...');
  const phase1Result = await executePhase1({
    region: target.region,
    stackName,
    synthTemplate,
    onProgress,
  });

  if (!phase1Result.success) {
    return { success: false, error: `Phase 1 failed: ${phase1Result.error}` };
  }

  // 6. Read deployed template
  onProgress('Reading deployed template...');
  const deployedTemplate = await getDeployedTemplate(target.region, stackName);
  if (!deployedTemplate) {
    return { success: false, error: 'Could not read deployed template after Phase 1' };
  }

  // 7. Build resources to import (caller-specific logic)
  const resourcesToImport = buildResourcesToImport(synthTemplate, deployedTemplate);

  if (resourcesToImport.length === 0) {
    return { success: true, noResources: true };
  }

  // 8. Phase 2: Import resources via CloudFormation
  onProgress(`Phase 2: Importing ${resourcesToImport.length} resource(s) via CloudFormation IMPORT...`);
  const phase2Result = await executePhase2({
    region: target.region,
    stackName,
    deployedTemplate,
    synthTemplate,
    resourcesToImport,
    assemblyDirectory,
    onProgress,
  });

  if (!phase2Result.success) {
    return { success: false, error: `Phase 2 failed: ${phase2Result.error}` };
  }

  // 9. Update deployed state
  onProgress('Updating deployed state...');
  await updateDeployedState(configIO, targetName, stackName, deployedStateEntries);
  onProgress('Deployed state updated');

  return { success: true };
}
