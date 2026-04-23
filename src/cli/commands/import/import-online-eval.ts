import type { OnlineEvalConfig } from '../../../schema';
import type { GetOnlineEvalConfigResult, OnlineEvalConfigSummary } from '../../aws/agentcore-control';
import {
  getOnlineEvaluationConfig,
  listAllAgentRuntimes,
  listAllOnlineEvaluationConfigs,
} from '../../aws/agentcore-control';
import { arnPrefix } from '../../aws/partition';
import { ANSI } from './constants';
import { failResult, findResourceInDeployedState, parseAndValidateArn } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';
import type { Command } from '@commander-js/extra-typings';

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
  evaluatorArns: string[]
): OnlineEvalConfig {
  if (detail.samplingPercentage == null) {
    throw new Error(`Online eval config "${detail.configName}" has no sampling configuration. Cannot import.`);
  }

  return {
    name: localName,
    agent: agentName,
    evaluators: evaluatorArns,
    samplingRate: detail.samplingPercentage,
    ...(detail.description && { description: detail.description }),
    ...(detail.executionStatus === 'ENABLED' && { enableOnCreate: true }),
  };
}

/**
 * Build evaluator ARNs from evaluator IDs.
 * Online eval configs reference evaluators by ARN rather than importing them,
 * since evaluators locked by an online eval config cannot be CFN-imported.
 */
function buildEvaluatorArns(evaluatorIds: string[], region: string, account: string): string[] {
  return evaluatorIds.map(id => `${arnPrefix(region)}:bedrock-agentcore:${region}:${account}:evaluator/${id}`);
}

/**
 * Create an online-eval descriptor with closed-over state for reference resolution.
 */
function createOnlineEvalDescriptor(): ResourceImportDescriptor<GetOnlineEvalConfigResult, OnlineEvalConfigSummary> {
  // Set by beforeConfigWrite, read by addToProjectSpec. Ordering guaranteed by executeResourceImport.
  let resolvedAgentName = '';
  let resolvedEvaluatorArns: string[] = [];

  return {
    resourceType: 'online-eval',
    displayName: 'online eval config',
    logCommand: 'import-online-eval',

    listResources: region => listAllOnlineEvaluationConfigs({ region }),
    getDetail: (region, id) => getOnlineEvaluationConfig({ region, configId: id }),
    parseResourceId: (arn, target) => parseAndValidateArn(arn, 'online-eval', target).resourceId,

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
        toOnlineEvalConfigSpec(detail, localName, resolvedAgentName, resolvedEvaluatorArns)
      );
    },

    cfnResourceType: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
    cfnNameProperty: 'OnlineEvaluationConfigName',
    cfnIdentifierKey: 'OnlineEvaluationConfigId',

    buildDeployedStateEntry: (name, id, d) => ({ type: 'online-eval', name, id, arn: d.configArn }),

    beforeConfigWrite: async ({ detail, localName, projectSpec, ctx, target, onProgress, logger }) => {
      logger.startStep('Resolve references');

      // Extract agent name from service names
      const awsAgentName = extractAgentName(detail.serviceNames ?? []);
      if (!awsAgentName) {
        return failResult(
          logger,
          'Could not determine agent name from online eval config. The config has no data source service names.',
          'online-eval',
          localName
        );
      }

      // Resolve the local agent name. The AWS name from the OEC service names
      // may differ from the local name if the runtime was imported with --name,
      // or it may include the CDK project prefix ("{projectName}_{agentName}").
      const agentNames = new Set((projectSpec.runtimes ?? []).map(r => r.name));
      let agentName: string | undefined;

      if (agentNames.has(awsAgentName)) {
        // Direct match — local name equals AWS name
        agentName = awsAgentName;
      } else {
        // Strip CDK project prefix if present (service names use "{projectName}_{agentName}")
        const prefix = `${ctx.projectName}_`;
        if (awsAgentName.startsWith(prefix)) {
          const stripped = awsAgentName.slice(prefix.length);
          if (agentNames.has(stripped)) {
            agentName = stripped;
          }
        }
      }

      if (!agentName) {
        // Look up the AWS runtime ID for the AWS name, then find the local name
        // that maps to it in deployed state.
        onProgress(`Agent "${awsAgentName}" not found by name, checking deployed state...`);
        const runtimes = await listAllAgentRuntimes({ region: target.region });
        const matchingRuntime = runtimes.find(r => r.agentRuntimeName === awsAgentName);

        if (matchingRuntime) {
          const targetName = target.name ?? 'default';
          const localMatch = await findResourceInDeployedState(
            ctx.configIO,
            targetName,
            'runtime',
            matchingRuntime.agentRuntimeId
          );
          if (localMatch && agentNames.has(localMatch)) {
            agentName = localMatch;
            onProgress(`Resolved AWS runtime "${awsAgentName}" to local name "${agentName}"`);
          }
        }
      }

      if (!agentName) {
        return failResult(
          logger,
          `Online eval config references agent "${awsAgentName}" which is not in this project. ` +
            `Import or add the agent first with \`agentcore import runtime\` or \`agentcore add agent\`.`,
          'online-eval',
          localName
        );
      }

      // Resolve evaluator IDs to ARNs
      const evaluatorIds = detail.evaluatorIds ?? [];
      if (evaluatorIds.length === 0) {
        return failResult(
          logger,
          'Online eval config has no evaluators configured. Cannot import.',
          'online-eval',
          localName
        );
      }

      resolvedEvaluatorArns = buildEvaluatorArns(evaluatorIds, target.region, target.account);
      resolvedAgentName = agentName;
      onProgress(`Agent: ${agentName}, Evaluators: ${resolvedEvaluatorArns.join(', ')}`);
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
        console.error(`\n${ANSI.red}[error]${ANSI.reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
