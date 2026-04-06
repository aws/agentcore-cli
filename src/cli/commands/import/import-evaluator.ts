import type { Evaluator } from '../../../schema';
import type { EvaluatorSummary, GetEvaluatorResult } from '../../aws/agentcore-control';
import {
  getEvaluator,
  getOnlineEvaluationConfig,
  listAllEvaluators,
  listAllOnlineEvaluationConfigs,
  updateOnlineEvalExecutionStatus,
} from '../../aws/agentcore-control';
import { ANSI } from './constants';
import { parseAndValidateArn } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';
import type { Command } from '@commander-js/extra-typings';

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
 * Create an evaluator descriptor with closed-over state for tracking
 * online eval configs that were temporarily disabled to unlock the evaluator.
 */
function createEvaluatorDescriptor(): {
  descriptor: ResourceImportDescriptor<GetEvaluatorResult, EvaluatorSummary>;
  getDisabledConfigs: () => { configId: string; configName: string }[];
  getRegion: () => string | undefined;
} {
  const disabledConfigs: { configId: string; configName: string }[] = [];
  let resolvedRegion: string | undefined;

  const descriptor: ResourceImportDescriptor<GetEvaluatorResult, EvaluatorSummary> = {
    resourceType: 'evaluator',
    displayName: 'evaluator',
    logCommand: 'import-evaluator',

    listResources: region => listAllEvaluators({ region }),
    getDetail: (region, id) => getEvaluator({ region, evaluatorId: id }),
    parseResourceId: (arn, target) => parseAndValidateArn(arn, 'evaluator', target).resourceId,

    extractSummaryId: s => s.evaluatorId,
    formatListItem: (s, i) =>
      `  ${ANSI.dim}[${i + 1}]${ANSI.reset} ${s.evaluatorName} — ${s.status}\n       ${ANSI.dim}${s.evaluatorArn}${ANSI.reset}`,
    formatAutoSelectMessage: s => `Found 1 evaluator: ${s.evaluatorName} (${s.evaluatorId}). Auto-selecting.`,

    extractDetailName: d => d.evaluatorName,
    extractDetailArn: d => d.evaluatorArn,
    readyStatus: 'ACTIVE',
    extractDetailStatus: d => d.status,

    getExistingNames: spec => (spec.evaluators ?? []).map(e => e.name),
    addToProjectSpec: (detail, localName, spec) => {
      (spec.evaluators ??= []).push(toEvaluatorSpec(detail, localName));
    },

    cfnResourceType: 'AWS::BedrockAgentCore::Evaluator',
    cfnNameProperty: 'EvaluatorName',
    cfnIdentifierKey: 'EvaluatorId',

    buildDeployedStateEntry: (name, id, d) => ({ type: 'evaluator', name, id, arn: d.evaluatorArn }),

    beforeConfigWrite: async ({ detail, target, onProgress, logger }) => {
      resolvedRegion = target.region;
      if (!detail.lockedForModification) return;

      logger.startStep('Unlock evaluator');
      onProgress('Evaluator is locked. Finding referencing online eval configs...');

      const allConfigs = await listAllOnlineEvaluationConfigs({ region: target.region });
      const enabledConfigs = allConfigs.filter(c => c.executionStatus === 'ENABLED');

      for (const config of enabledConfigs) {
        const configDetail = await getOnlineEvaluationConfig({
          region: target.region,
          configId: config.onlineEvaluationConfigId,
        });
        if (configDetail.evaluatorIds?.includes(detail.evaluatorId)) {
          onProgress(`Disabling online eval config: ${config.onlineEvaluationConfigName}`);
          await updateOnlineEvalExecutionStatus({
            region: target.region,
            onlineEvaluationConfigId: config.onlineEvaluationConfigId,
            executionStatus: 'DISABLED',
          });
          disabledConfigs.push({
            configId: config.onlineEvaluationConfigId,
            configName: config.onlineEvaluationConfigName,
          });
        }
      }

      if (disabledConfigs.length > 0) {
        onProgress(`Disabled ${disabledConfigs.length} online eval config(s) to unlock evaluator`);
      } else {
        onProgress('Evaluator is locked but no enabled online eval configs reference it');
      }
      logger.endStep('success');
    },
  };

  return {
    descriptor,
    getDisabledConfigs: () => [...disabledConfigs],
    getRegion: () => resolvedRegion,
  };
}

/**
 * Re-enable online eval configs that were temporarily disabled during import.
 */
async function reEnableConfigs(
  configs: { configId: string; configName: string }[],
  region: string,
  onWarn: (msg: string) => void
): Promise<void> {
  for (const config of configs) {
    try {
      await updateOnlineEvalExecutionStatus({
        region,
        onlineEvaluationConfigId: config.configId,
        executionStatus: 'ENABLED',
      });
    } catch (err) {
      onWarn(
        `Warning: Could not re-enable online eval config "${config.configName}" (${config.configId}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Handle `agentcore import evaluator`.
 */
export async function handleImportEvaluator(options: ImportResourceOptions): Promise<ImportResourceResult> {
  const { descriptor, getDisabledConfigs, getRegion } = createEvaluatorDescriptor();

  try {
    const result = await executeResourceImport(descriptor, options);
    return result;
  } finally {
    const disabled = getDisabledConfigs();
    const region = getRegion();
    if (disabled.length > 0 && region) {
      await reEnableConfigs(disabled, region, msg => console.warn(msg));
      const names = disabled.map(c => c.configName).join(', ');
      console.warn(
        `\n${ANSI.yellow}Warning:${ANSI.reset} ${disabled.length} online eval config(s) were temporarily disabled to unlock this evaluator and have been re-enabled: ${names}`
      );
    }
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
        console.log(`${ANSI.green}Evaluator imported successfully!${ANSI.reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
      } else {
        console.error(`\n\x1b[31m[error]${ANSI.reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
