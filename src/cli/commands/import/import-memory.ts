import type { Memory } from '../../../schema';
import type { MemoryDetail } from '../../aws/agentcore-control';
import { getMemoryDetail, listMemories } from '../../aws/agentcore-control';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { silentIoHost } from '../../cdk/toolkit-lib';
import { ExecLogger } from '../../logging';
import { bootstrapEnvironment, buildCdkProject, checkBootstrapNeeded, synthesizeCdk } from '../../operations/deploy';
import {
  findResourceInDeployedState,
  parseAndValidateArn,
  resolveImportTarget,
  resolveProjectContext,
  toStackName,
  updateDeployedState,
} from './import-utils';
import { executePhase1, getDeployedTemplate } from './phase1-update';
import { executePhase2, publishCdkAssets } from './phase2-import';
import type { CfnTemplate } from './template-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult, ResourceToImport } from './types';
import type { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';
import * as path from 'node:path';

const green = '\x1b[32m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

/**
 * Map strategy type from AWS API format to CLI schema format.
 * The API returns types like "SEMANTIC_OVERRIDE", "SUMMARY_OVERRIDE", etc.
 * CLI uses "SEMANTIC", "SUMMARIZATION", "USER_PREFERENCE", "EPISODIC".
 */
function mapStrategyType(apiType: string): string {
  const mapping: Record<string, string> = {
    SEMANTIC_OVERRIDE: 'SEMANTIC',
    SUMMARY_OVERRIDE: 'SUMMARIZATION',
    USER_PREFERENCE_OVERRIDE: 'USER_PREFERENCE',
    EPISODIC_OVERRIDE: 'EPISODIC',
    // Direct mappings
    SEMANTIC: 'SEMANTIC',
    SUMMARIZATION: 'SUMMARIZATION',
    USER_PREFERENCE: 'USER_PREFERENCE',
    EPISODIC: 'EPISODIC',
  };
  return mapping[apiType] ?? apiType;
}

/**
 * Map an AWS GetMemory response to the CLI Memory format.
 */
function toMemorySpec(memory: MemoryDetail, localName: string): Memory {
  const strategies: Memory['strategies'] = memory.strategies.map(s => {
    const mappedType = mapStrategyType(s.type);
    return {
      type: mappedType as Memory['strategies'][number]['type'],
      ...(s.name && { name: s.name }),
      ...(s.description && { description: s.description }),
      ...(s.namespaces && s.namespaces.length > 0 && { namespaces: s.namespaces }),
      ...(s.reflectionNamespaces &&
        s.reflectionNamespaces.length > 0 && { reflectionNamespaces: s.reflectionNamespaces }),
    };
  });

  return {
    name: localName,
    eventExpiryDuration: Math.max(7, Math.min(365, memory.eventExpiryDuration)),
    strategies,
  };
}

/**
 * Handle `agentcore import memory`.
 */
export async function handleImportMemory(options: ImportResourceOptions): Promise<ImportResourceResult> {
  const logger = new ExecLogger({ command: 'import-memory' });
  const onProgress = (message: string) => {
    console.log(`${green}[done]${reset}  ${message}`);
  };

  try {
    // 1. Validate project context
    logger.startStep('Validate project context');
    const ctx = await resolveProjectContext();
    logger.endStep('success');

    // 2. Resolve deployment target
    logger.startStep('Resolve deployment target');
    const target = await resolveImportTarget({
      configIO: ctx.configIO,
      targetName: options.target,
      onProgress,
    });
    logger.endStep('success');

    // 3. Get memory details from AWS
    logger.startStep('Fetch memory from AWS');
    let memoryId: string;

    if (options.arn) {
      const parsed = parseAndValidateArn(options.arn, 'memory', target);
      memoryId = parsed.resourceId;
    } else {
      // List memories and show to user
      onProgress('Listing memories in your account...');
      const listResult = await listMemories({ region: target.region, maxResults: 100 });

      if (listResult.memories.length === 0) {
        const error = 'No memories found in your account.';
        logger.endStep('error', error);
        logger.finalize(false);
        return {
          success: false,
          error,
          resourceType: 'memory',
          resourceName: '',
          logPath: logger.getRelativeLogPath(),
        };
      }

      // Display list
      console.log(`\nFound ${listResult.memories.length} memory(ies):\n`);
      for (let i = 0; i < listResult.memories.length; i++) {
        const m = listResult.memories[i]!;
        console.log(`  ${dim}[${i + 1}]${reset} ${m.memoryId} — ${m.status}`);
      }
      console.log('');

      const error = 'Multiple memories found. Use --arn <memoryArn> to specify which memory to import.';
      logger.endStep('error', error);
      logger.finalize(false);
      return { success: false, error, resourceType: 'memory', resourceName: '', logPath: logger.getRelativeLogPath() };
    }

    onProgress(`Fetching memory details for ${memoryId}...`);
    const memoryDetail = await getMemoryDetail({ region: target.region, memoryId });

    if (memoryDetail.status !== 'ACTIVE') {
      onProgress(`Warning: Memory status is ${memoryDetail.status}, not ACTIVE`);
    }

    const localName = options.name ?? memoryDetail.name;
    onProgress(`Memory: ${memoryDetail.name} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set((projectSpec.memories ?? []).map(m => m.name));
    if (existingNames.has(localName)) {
      const error = `Memory "${localName}" already exists in the project. Use --name to specify a different local name.`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'memory', memoryId);
    if (existingResource) {
      const error = `Memory "${memoryId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 5. Add to project config
    logger.startStep('Update project config');
    const memorySpec = toMemorySpec(memoryDetail, localName);
    (projectSpec.memories ??= []).push(memorySpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    onProgress(`Added memory "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 6. Build and synth CDK
    logger.startStep('Build and synth CDK');
    onProgress('Building CDK project...');
    const cdkProject = new LocalCdkProject(ctx.projectRoot);
    await buildCdkProject(cdkProject);

    onProgress('Synthesizing CloudFormation template...');
    const synthResult = await synthesizeCdk(cdkProject, { ioHost: silentIoHost });
    const { toolkitWrapper } = synthResult;

    const synthInfo = await toolkitWrapper.synth();
    const assemblyDirectory = synthInfo.assemblyDirectory;
    const stackName = toStackName(ctx.projectName, targetName);
    const synthTemplatePath = path.join(assemblyDirectory, `${stackName}.template.json`);

    let synthTemplate: CfnTemplate;
    try {
      synthTemplate = JSON.parse(fs.readFileSync(synthTemplatePath, 'utf-8')) as CfnTemplate;
    } catch {
      const files = fs.readdirSync(assemblyDirectory).filter((f: string) => f.endsWith('.template.json'));
      if (files.length === 0) {
        await toolkitWrapper.dispose();
        const error = 'No CloudFormation template found in CDK assembly';
        logger.endStep('error', error);
        logger.finalize(false);
        return {
          success: false,
          error,
          resourceType: 'memory',
          resourceName: localName,
          logPath: logger.getRelativeLogPath(),
        };
      }
      synthTemplate = JSON.parse(fs.readFileSync(path.join(assemblyDirectory, files[0]!), 'utf-8')) as CfnTemplate;
    }

    // Check CDK bootstrap
    onProgress('Checking CDK bootstrap status...');
    const bootstrapCheck = await checkBootstrapNeeded([target]);
    if (bootstrapCheck.needsBootstrap) {
      onProgress('Bootstrapping AWS environment...');
      await bootstrapEnvironment(toolkitWrapper, target);
      onProgress('CDK bootstrap complete');
    }

    await toolkitWrapper.dispose();
    logger.endStep('success');

    // 7. Publish CDK assets
    logger.startStep('Publish CDK assets');
    onProgress('Publishing CDK assets to S3...');
    await publishCdkAssets(assemblyDirectory, target.region, onProgress);
    logger.endStep('success');

    // 8. Phase 1: Deploy companion resources
    logger.startStep('Phase 1: Deploy companion resources');
    onProgress('Phase 1: Deploying companion resources...');
    const phase1Result = await executePhase1({
      region: target.region,
      stackName,
      synthTemplate,
      onProgress,
    });

    if (!phase1Result.success) {
      const error = `Phase 1 failed: ${phase1Result.error}`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 9. Phase 2: Import the memory resource
    logger.startStep('Phase 2: Import memory resource');
    onProgress('Reading deployed template...');
    const deployedTemplate = await getDeployedTemplate(target.region, stackName);
    if (!deployedTemplate) {
      const error = 'Could not read deployed template after Phase 1';
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    // Find the logical ID for this memory in the synth template
    let logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', localName);

    // CDK prefixes memory names with the project name
    if (!logicalId) {
      const prefixedName = `${ctx.projectName}_${localName}`;
      logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', prefixedName);
    }

    if (!logicalId) {
      const memoryLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory');
      if (memoryLogicalIds.length === 1) {
        logicalId = memoryLogicalIds[0];
      }
    }

    if (!logicalId) {
      const error = `Could not find logical ID for memory "${localName}" in CloudFormation template`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    const resourcesToImport: ResourceToImport[] = [
      {
        resourceType: 'AWS::BedrockAgentCore::Memory',
        logicalResourceId: logicalId,
        resourceIdentifier: { MemoryId: memoryId },
      },
    ];

    onProgress('Phase 2: Importing memory via CloudFormation IMPORT...');
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
      const error = `Phase 2 failed: ${phase2Result.error}`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 10. Update deployed state
    logger.startStep('Update deployed state');
    await updateDeployedState(ctx.configIO, targetName, stackName, [
      {
        type: 'memory',
        name: localName,
        id: memoryId,
        arn: memoryDetail.memoryArn,
      },
    ]);
    onProgress('Deployed state updated');
    logger.endStep('success');

    logger.finalize(true);
    return {
      success: true,
      resourceType: 'memory',
      resourceName: localName,
      resourceId: memoryId,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log(message, 'error');
    logger.finalize(false);
    return {
      success: false,
      error: message,
      resourceType: 'memory',
      resourceName: options.name ?? '',
      logPath: logger.getRelativeLogPath(),
    };
  }
}

/**
 * Register the `import memory` subcommand.
 */
export function registerImportMemory(importCmd: Command): void {
  importCmd
    .command('memory')
    .description('Import an existing AgentCore Memory from your AWS account')
    .option('--arn <memoryArn>', 'Memory ARN to import')
    .option('--target <target>', 'Deployment target name')
    .option('--name <name>', 'Local name for the imported memory')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportMemory(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${green}Memory imported successfully!${reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
      } else {
        console.error(`\n\x1b[31m[error]${reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
