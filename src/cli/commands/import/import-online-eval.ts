import type { AgentCoreProjectSpec, DeployedState, OnlineEvalConfig } from '../../../schema';
import type { GetOnlineEvalConfigResult, OnlineEvalConfigSummary } from '../../aws/agentcore-control';
import { getOnlineEvaluationConfig, listAllOnlineEvaluationConfigs } from '../../aws/agentcore-control';
import { ANSI } from './constants';
import { failResult } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';
import type { Command } from '@commander-js/extra-typings';

const ARN_PREFIX = 'arn:';

/**
 * Derive the agent name from the online eval config's service names.
 * Service names follow the pattern: "{agentName}.DEFAULT"
 */
export function extractAgentName(serviceNames: string[]): string | undefined {
  if (serviceNames.length === 0) return undefined;
  const serviceName = serviceNames[0]!;
  const dotIndex = serviceName.lastIndexOf('.');
  if (dotIndex === -1) return serviceName;
  return serviceName.slice(0, dotIndex);
}

/**
 * Map an AWS GetOnlineEvaluationConfig response to the CLI OnlineEvalConfig spec format.
 */
export function toOnlineEvalConfigSpec(
  detail: GetOnlineEvalConfigResult,
  localName: string,
  agentName: string,
  evaluatorNames: string[]
): OnlineEvalConfig {
  if (!detail.samplingPercentage) {
    throw new Error(`Online eval config "${detail.configName}" has no sampling configuration. Cannot import.`);
  }

  return {
    name: localName,
    agent: agentName,
    evaluators: evaluatorNames,
    samplingRate: detail.samplingPercentage,
    ...(detail.description && { description: detail.description }),
    ...(detail.executionStatus === 'ENABLED' && { enableOnCreate: true }),
  };
}

/**
 * Resolve evaluator IDs to local names or ARNs.
 * If an evaluator ID matches a local evaluator (by checking deployed state), use the local name.
 * Otherwise, construct an ARN so the schema validation passes.
 */
function resolveEvaluatorReferences(
  evaluatorIds: string[],
  projectSpec: AgentCoreProjectSpec,
  deployedEvaluators: Record<string, string>,
  region: string,
  account: string
): string[] {
  const localEvaluators = projectSpec.evaluators ?? [];

  return evaluatorIds.map(id => {
    // First check deployed state for an exact physical ID → local name match
    // This handles imported evaluators where the local name differs from the AWS name
    if (deployedEvaluators[id]) {
      return deployedEvaluators[id];
    }
    // Then check if the evaluator ID contains a local evaluator name
    // This handles evaluators deployed by the same project (ID pattern: {projectName}_{evaluatorName}-{suffix})
    for (const localEval of localEvaluators) {
      if (id.includes(localEval.name)) {
        return localEval.name;
      }
    }
    // Fall back to ARN format (bypasses schema cross-reference validation)
    return `${ARN_PREFIX}aws:bedrock-agentcore:${region}:${account}:evaluator/${id}`;
  });
}

/**
 * Create an online-eval descriptor with closed-over state for reference resolution.
 */
function createOnlineEvalDescriptor(): ResourceImportDescriptor<GetOnlineEvalConfigResult, OnlineEvalConfigSummary> {
  let resolvedAgentName = '';
  let resolvedEvaluatorNames: string[] = [];

  return {
    resourceType: 'online-eval',
    displayName: 'online eval config',
    logCommand: 'import-online-eval',

    listResources: region => listAllOnlineEvaluationConfigs({ region }),
    getDetail: (region, id) => getOnlineEvaluationConfig({ region, configId: id }),
    parseResourceId: arn => {
      const match = /\/([^/]+)$/.exec(arn);
      if (!match) {
        throw new Error(`Could not parse config ID from ARN: ${arn}`);
      }
      return match[1]!;
    },

    extractSummaryId: s => s.onlineEvaluationConfigId,
    formatListItem: (s, i) =>
      `  ${ANSI.dim}[${i + 1}]${ANSI.reset} ${s.onlineEvaluationConfigName} — ${s.status} (${s.executionStatus})\n       ${ANSI.dim}${s.onlineEvaluationConfigArn}${ANSI.reset}`,
    formatAutoSelectMessage: s =>
      `Found 1 config: ${s.onlineEvaluationConfigName} (${s.onlineEvaluationConfigId}). Auto-selecting.`,

    extractDetailName: d => d.configName,
    extractDetailArn: d => d.configArn,
    readyStatus: 'ACTIVE',
    extractDetailStatus: d => d.status,

    getExistingNames: spec => (spec.onlineEvalConfigs ?? []).map(c => c.name),
    addToProjectSpec: (detail, localName, spec) => {
      (spec.onlineEvalConfigs ??= []).push(
        toOnlineEvalConfigSpec(detail, localName, resolvedAgentName, resolvedEvaluatorNames)
      );
    },

    cfnResourceType: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
    cfnNameProperty: 'OnlineEvaluationConfigName',
    cfnIdentifierKey: 'OnlineEvaluationConfigId',

    buildDeployedStateEntry: (name, id, d) => ({ type: 'online-eval', name, id, arn: d.configArn }),

    beforeConfigWrite: async ({ detail, localName, projectSpec, ctx, target, onProgress, logger }) => {
      logger.startStep('Resolve references');

      // Extract agent name from service names
      const agentName = extractAgentName(detail.serviceNames ?? []);
      if (!agentName) {
        return failResult(
          logger,
          'Could not determine agent name from online eval config. The config has no data source service names.',
          'online-eval',
          localName
        );
      }

      // Validate agent exists in project
      const agentNames = new Set((projectSpec.runtimes ?? []).map(r => r.name));
      if (!agentNames.has(agentName)) {
        return failResult(
          logger,
          `Online eval config references agent "${agentName}" which is not in this project. ` +
            `Import or add the agent first with \`agentcore import runtime\` or \`agentcore add agent\`.`,
          'online-eval',
          localName
        );
      }

      // Resolve evaluator IDs to local names or ARNs
      const evaluatorIds = detail.evaluatorIds ?? [];
      if (evaluatorIds.length === 0) {
        return failResult(
          logger,
          'Online eval config has no evaluators configured. Cannot import.',
          'online-eval',
          localName
        );
      }

      // Build reverse map from deployed state: evaluatorId → localName
      const deployedEvaluators: Record<string, string> = {};
      const deployedState: DeployedState = await ctx.configIO
        .readDeployedState()
        .catch((): DeployedState => ({ targets: {} }));
      const targetName = target.name ?? 'default';
      const evalEntries = deployedState.targets[targetName]?.resources?.evaluators;
      if (evalEntries) {
        for (const [localEvalName, entry] of Object.entries(evalEntries)) {
          deployedEvaluators[entry.evaluatorId] = localEvalName;
        }
      }

      resolvedEvaluatorNames = resolveEvaluatorReferences(
        evaluatorIds,
        projectSpec,
        deployedEvaluators,
        target.region,
        target.account
      );
      resolvedAgentName = agentName;
      onProgress(`Agent: ${agentName}, Evaluators: ${resolvedEvaluatorNames.join(', ')}`);
      logger.endStep('success');
    },
  };
}

/**
 * Handle `agentcore import online-eval`.
 */
export async function handleImportOnlineEval(options: ImportResourceOptions): Promise<ImportResourceResult> {
  return executeResourceImport(createOnlineEvalDescriptor(), options);
}

/**
 * Register the `import online-eval` subcommand.
 */
export function registerImportOnlineEval(importCmd: Command): void {
  importCmd
    .command('online-eval')
    .description('Import an existing AgentCore Online Evaluation Config from your AWS account')
    .option('--arn <configArn>', 'Online evaluation config ARN to import')
    .option('--name <name>', 'Local name for the imported online eval config')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportOnlineEval(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${ANSI.green}Online eval config imported successfully!${ANSI.reset}`);
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
