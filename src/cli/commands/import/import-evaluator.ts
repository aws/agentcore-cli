import type { AgentCoreProjectSpec, Evaluator } from '../../../schema';
import type { GetEvaluatorResult } from '../../aws/agentcore-control';
import { getEvaluator, listAllEvaluators } from '../../aws/agentcore-control';
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
 * Map an AWS GetEvaluator response to the CLI Evaluator spec format.
 */
export function toEvaluatorSpec(detail: GetEvaluatorResult, localName: string): Evaluator {
  const level = (detail.level ?? 'SESSION') as Evaluator['level'];

  let config: Evaluator['config'];

  if (detail.evaluatorConfig?.llmAsAJudge) {
    const llm = detail.evaluatorConfig.llmAsAJudge;
    config = {
      llmAsAJudge: {
        model: llm.model,
        instructions: llm.instructions,
        ratingScale: llm.ratingScale,
      },
    };
  } else if (detail.evaluatorConfig?.codeBased) {
    config = {
      codeBased: {
        external: {
          lambdaArn: detail.evaluatorConfig.codeBased.lambdaArn,
        },
      },
    };
  } else {
    throw new Error(
      `Evaluator "${detail.evaluatorName}" has no recognizable config. ` +
        'Only LLM-as-a-Judge and code-based evaluators can be imported.'
    );
  }

  return {
    name: localName,
    level,
    ...(detail.description && { description: detail.description }),
    config,
    ...(detail.tags && Object.keys(detail.tags).length > 0 && { tags: detail.tags }),
  };
}

/**
 * Handle `agentcore import evaluator`.
 */
export async function handleImportEvaluator(options: ImportResourceOptions): Promise<ImportResourceResult> {
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
    importCtx = await resolveImportContext(options, 'import-evaluator');
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Get evaluator details from AWS
    logger.startStep('Fetch evaluator from AWS');
    let evaluatorId: string;

    if (options.arn) {
      const parsed = parseAndValidateArn(options.arn, 'evaluator', target);
      evaluatorId = parsed.resourceId;
    } else {
      onProgress('Listing evaluators in your account...');
      const evaluators = await listAllEvaluators({ region: target.region });

      if (evaluators.length === 0) {
        return failResult(logger, 'No custom evaluators found in your account.', 'evaluator', '');
      }

      if (evaluators.length === 1) {
        evaluatorId = evaluators[0]!.evaluatorId;
        onProgress(`Found 1 evaluator: ${evaluators[0]!.evaluatorName} (${evaluatorId}). Auto-selecting.`);
      } else {
        console.log(`\nFound ${evaluators.length} evaluator(s):\n`);
        for (let i = 0; i < evaluators.length; i++) {
          const e = evaluators[i]!;
          console.log(`  ${dim}[${i + 1}]${reset} ${e.evaluatorName} — ${e.status}`);
          console.log(`       ${dim}${e.evaluatorArn}${reset}`);
        }
        console.log('');

        return failResult(
          logger,
          'Multiple evaluators found. Use --arn <evaluatorArn> to specify which evaluator to import.',
          'evaluator',
          ''
        );
      }
    }

    onProgress(`Fetching evaluator details for ${evaluatorId}...`);
    const evaluatorDetail = await getEvaluator({ region: target.region, evaluatorId });

    if (evaluatorDetail.status !== 'ACTIVE') {
      onProgress(`Warning: Evaluator status is ${evaluatorDetail.status}, not ACTIVE`);
    }

    // Derive local name
    let localName = options.name ?? evaluatorDetail.evaluatorName;
    const prefix = `${ctx.projectName}_`;
    if (localName.startsWith(prefix)) {
      localName = localName.slice(prefix.length);
    }
    const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        'evaluator',
        localName
      );
    }
    onProgress(`Evaluator: ${evaluatorDetail.evaluatorName} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set((projectSpec.evaluators ?? []).map(e => e.name));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `Evaluator "${localName}" already exists in the project. Use --name to specify a different local name.`,
        'evaluator',
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'evaluator', evaluatorId);
    if (existingResource) {
      return failResult(
        logger,
        `Evaluator "${evaluatorId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`,
        'evaluator',
        localName
      );
    }
    logger.endStep('success');

    // 5. Add to project config
    logger.startStep('Update project config');
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    const evaluatorSpec = toEvaluatorSpec(evaluatorDetail, localName);
    (projectSpec.evaluators ??= []).push(evaluatorSpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added evaluator "${localName}" to agentcore.json`);
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
        // Try matching by EvaluatorName property (plain name first, then prefixed)
        let logicalId = findLogicalIdByProperty(
          synthTemplate,
          'AWS::BedrockAgentCore::Evaluator',
          'EvaluatorName',
          localName
        );

        if (!logicalId) {
          const prefixedName = `${ctx.projectName}_${localName}`;
          logicalId = findLogicalIdByProperty(
            synthTemplate,
            'AWS::BedrockAgentCore::Evaluator',
            'EvaluatorName',
            prefixedName
          );
        }

        // Fall back to single evaluator by type
        if (!logicalId) {
          const evaluatorLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Evaluator');
          if (evaluatorLogicalIds.length === 1) {
            logicalId = evaluatorLogicalIds[0];
          }
        }

        if (!logicalId) {
          return [];
        }

        return [
          {
            resourceType: 'AWS::BedrockAgentCore::Evaluator',
            logicalResourceId: logicalId,
            resourceIdentifier: { EvaluatorId: evaluatorId },
          },
        ];
      },
      deployedStateEntries: [
        {
          type: 'evaluator',
          name: localName,
          id: evaluatorId,
          arn: evaluatorDetail.evaluatorArn,
        },
      ],
    });

    if (pipelineResult.noResources) {
      const error = `Could not find logical ID for evaluator "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, 'evaluator', localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: 'evaluator',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    logger.finalize(true);
    return {
      success: true,
      resourceType: 'evaluator',
      resourceName: localName,
      resourceId: evaluatorId,
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
      resourceType: 'evaluator',
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
    };
  }
}

/**
 * Register the `import evaluator` subcommand.
 */
export function registerImportEvaluator(importCmd: Command): void {
  importCmd
    .command('evaluator')
    .description('Import an existing AgentCore Evaluator from your AWS account')
    .option('--arn <evaluatorArn>', 'Evaluator ARN to import')
    .option('--name <name>', 'Local name for the imported evaluator')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportEvaluator(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${green}Evaluator imported successfully!${reset}`);
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
