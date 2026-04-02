import type { AgentCoreProjectSpec, Memory } from '../../../schema';
import type { MemoryDetail } from '../../aws/agentcore-control';
import { getMemoryDetail, listAllMemories } from '../../aws/agentcore-control';
import { executeCdkImportPipeline } from './import-pipeline';
import {
  failResult,
  findResourceInDeployedState,
  parseAndValidateArn,
  resolveImportContext,
  toStackName,
} from './import-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult } from './types';
import type { Command } from '@commander-js/extra-typings';

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
 * Filter out API-internal namespace patterns that are auto-generated
 * and should not be included in local config.
 * These patterns contain template variables like {memoryStrategyId}, {actorId}, etc.
 */
function filterInternalNamespaces(namespaces: string[]): string[] {
  return namespaces.filter(ns => !ns.includes('{memoryStrategyId}'));
}

/**
 * Map an AWS GetMemory response to the CLI Memory format.
 */
function toMemorySpec(memory: MemoryDetail, localName: string): Memory {
  const strategies: Memory['strategies'] = memory.strategies.map(s => {
    const mappedType = mapStrategyType(s.type);
    const filteredNamespaces = s.namespaces ? filterInternalNamespaces(s.namespaces) : [];
    return {
      type: mappedType as Memory['strategies'][number]['type'],
      ...(s.name && { name: s.name }),
      ...(s.description && { description: s.description }),
      ...(filteredNamespaces.length > 0 && { namespaces: filteredNamespaces }),
      ...(s.reflectionNamespaces &&
        s.reflectionNamespaces.length > 0 && { reflectionNamespaces: s.reflectionNamespaces }),
    };
  });

  return {
    name: localName,
    eventExpiryDuration: Math.max(7, Math.min(365, memory.eventExpiryDuration)),
    strategies,
    ...(memory.tags && Object.keys(memory.tags).length > 0 && { tags: memory.tags }),
    ...(memory.encryptionKeyArn && { encryptionKeyArn: memory.encryptionKeyArn }),
    ...(memory.executionRoleArn && { executionRoleArn: memory.executionRoleArn }),
  };
}

/**
 * Handle `agentcore import memory`.
 */
export async function handleImportMemory(options: ImportResourceOptions): Promise<ImportResourceResult> {
  // Rollback state
  let configSnapshot: AgentCoreProjectSpec | undefined;
  let configWritten = false;

  let importCtx: Awaited<ReturnType<typeof resolveImportContext>> | undefined;

  const rollback = async () => {
    if (configWritten && configSnapshot && importCtx) {
      try {
        await importCtx.ctx.configIO.writeProjectSpec(configSnapshot);
      } catch (err) {
        console.warn(`Warning: Could not restore agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    // 1-2. Validate project context and resolve target
    importCtx = await resolveImportContext(options, 'import-memory');
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Get memory details from AWS
    logger.startStep('Fetch memory from AWS');
    let memoryId: string;

    if (options.arn) {
      const parsed = parseAndValidateArn(options.arn, 'memory', target);
      memoryId = parsed.resourceId;
    } else {
      onProgress('Listing memories in your account...');
      const memories = await listAllMemories({ region: target.region });

      if (memories.length === 0) {
        return failResult(logger, 'No memories found in your account.', 'memory', '');
      }

      if (memories.length === 1) {
        memoryId = memories[0]!.memoryId;
        onProgress(`Found 1 memory: ${memoryId}. Auto-selecting.`);
      } else {
        console.log(`\nFound ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}:\n`);
        for (let i = 0; i < memories.length; i++) {
          const m = memories[i]!;
          console.log(`  ${dim}[${i + 1}]${reset} ${m.memoryId} — ${m.status}`);
          console.log(`       ${dim}${m.memoryArn}${reset}`);
        }
        console.log('');

        return failResult(
          logger,
          'Multiple memories found. Use --arn <memoryArn> to specify which memory to import.',
          'memory',
          ''
        );
      }
    }

    onProgress(`Fetching memory details for ${memoryId}...`);
    const memoryDetail = await getMemoryDetail({ region: target.region, memoryId });

    if (memoryDetail.status !== 'ACTIVE') {
      onProgress(`Warning: Memory status is ${memoryDetail.status}, not ACTIVE`);
    }

    const localName = options.name ?? memoryDetail.name;
    const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        'memory',
        localName
      );
    }
    onProgress(`Memory: ${memoryDetail.name} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set((projectSpec.memories ?? []).map(m => m.name));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `Memory "${localName}" already exists in the project. Use --name to specify a different local name.`,
        'memory',
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'memory', memoryId);
    if (existingResource) {
      return failResult(
        logger,
        `Memory "${memoryId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`,
        'memory',
        localName
      );
    }
    logger.endStep('success');

    // 5. Add to project config
    logger.startStep('Update project config');
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    const memorySpec = toMemorySpec(memoryDetail, localName);
    (projectSpec.memories ??= []).push(memorySpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added memory "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 6-10. CDK build → synth → bootstrap → phase 1 → phase 2 → update state
    logger.startStep('Build and synth CDK');
    const stackName = toStackName(ctx.projectName, targetName);

    const pipelineResult = await executeCdkImportPipeline({
      projectRoot: ctx.projectRoot,
      stackName,
      target,
      configIO: ctx.configIO,
      targetName,
      onProgress,
      buildResourcesToImport: synthTemplate => {
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
          return [];
        }

        return [
          {
            resourceType: 'AWS::BedrockAgentCore::Memory',
            logicalResourceId: logicalId,
            resourceIdentifier: { MemoryId: memoryId },
          },
        ];
      },
      deployedStateEntries: [
        {
          type: 'memory',
          name: localName,
          id: memoryId,
          arn: memoryDetail.memoryArn,
        },
      ],
    });

    if (pipelineResult.noResources) {
      const error = `Could not find logical ID for memory "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, 'memory', localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: 'memory',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
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
    await rollback();
    if (importCtx) {
      importCtx.logger.log(message, 'error');
      importCtx.logger.finalize(false);
    }
    return {
      success: false,
      error: message,
      resourceType: 'memory',
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
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
