import type { Evaluator } from '../../../schema';
import type { EvaluatorSummary, GetEvaluatorResult } from '../../aws/agentcore-control';
import {
  getEvaluator,
  getOnlineEvaluationConfig,
  listAllEvaluators,
  listAllOnlineEvaluationConfigs,
} from '../../aws/agentcore-control';
import { ANSI } from './constants';
import { failResult, parseAndValidateArn } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Map an AWS GetEvaluator response to the CLI Evaluator spec format.
 */
export function toEvaluatorSpec(detail: GetEvaluatorResult, localName: string): Evaluator {
  const level = detail.level || 'SESSION';

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

const evaluatorDescriptor: ResourceImportDescriptor<GetEvaluatorResult, EvaluatorSummary> = {
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

  beforeConfigWrite: async ({ detail, localName, target, onProgress, logger }) => {
    // Check if any online eval config references this evaluator.
    // CFN IMPORT of locked evaluators always fails because CFN triggers a
    // post-import TagResource call that the resource handler rejects.
    logger.startStep('Check for online eval config references');
    onProgress('Checking if evaluator is referenced by an online eval config...');

    const oecSummaries = await listAllOnlineEvaluationConfigs({ region: target.region });
    if (oecSummaries.length > 0) {
      const oecDetails = await Promise.all(
        oecSummaries.map(s =>
          getOnlineEvaluationConfig({ region: target.region, configId: s.onlineEvaluationConfigId })
        )
      );

      const referencingOec = oecDetails.find(oec => oec.evaluatorIds?.includes(detail.evaluatorId));

      if (referencingOec) {
        return failResult(
          logger,
          `Evaluator "${localName}" is referenced by online eval config "${referencingOec.configName}" and cannot be imported directly (locked by CloudFormation).\n` +
            `To import this evaluator along with its online eval config, run:\n` +
            `  agentcore import online-eval --arn ${referencingOec.configArn}`,
          'evaluator',
          localName
        );
      }
    }

    logger.endStep('success');
  },
};

/**
 * Handle `agentcore import evaluator`.
 */
export async function handleImportEvaluator(options: ImportResourceOptions): Promise<ImportResourceResult> {
  return executeResourceImport(evaluatorDescriptor, options);
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
        console.error(`\n${ANSI.red}[error]${ANSI.reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
