import type { AgentCoreProjectSpec, OnlineEvalConfig } from '../../../schema';
import type { GetOnlineEvalConfigResult } from '../../aws/agentcore-control';
import { getOnlineEvaluationConfig, listAllOnlineEvaluationConfigs } from '../../aws/agentcore-control';
import { executeCdkImportPipeline } from './import-pipeline';
import { failResult, findResourceInDeployedState, resolveImportContext, toStackName } from './import-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult } from './types';
import type { Command } from '@commander-js/extra-typings';

const green = '\x1b[32m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

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
 *
 * @param detail - The AWS online eval config details
 * @param localName - The local name for this config in agentcore.json
 * @param agentName - The resolved local agent name
 * @param evaluatorNames - Mapping from evaluator ID to local evaluator name (or ARN fallback)
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
  region: string,
  account: string
): string[] {
  const localEvaluators = projectSpec.evaluators ?? [];

  return evaluatorIds.map(id => {
    // Check if this evaluator ID matches a local evaluator name
    // The CDK creates evaluators with name: {projectName}_{evaluatorName}
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
 * Handle `agentcore import online-eval`.
 */
export async function handleImportOnlineEval(options: ImportResourceOptions): Promise<ImportResourceResult> {
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
    importCtx = await resolveImportContext(options, 'import-online-eval');
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Get online eval config details from AWS
    logger.startStep('Fetch online eval config from AWS');
    let configId: string;

    if (options.arn) {
      // Parse config ID from ARN (last segment after /)
      const arnMatch = /\/([^/]+)$/.exec(options.arn);
      if (!arnMatch) {
        return failResult(logger, `Could not parse config ID from ARN: ${options.arn}`, 'online-eval', '');
      }
      configId = arnMatch[1]!;
    } else {
      onProgress('Listing online eval configs in your account...');
      const configs = await listAllOnlineEvaluationConfigs({ region: target.region });

      if (configs.length === 0) {
        return failResult(logger, 'No online evaluation configs found in your account.', 'online-eval', '');
      }

      if (configs.length === 1) {
        configId = configs[0]!.onlineEvaluationConfigId;
        onProgress(`Found 1 config: ${configs[0]!.onlineEvaluationConfigName} (${configId}). Auto-selecting.`);
      } else {
        console.log(`\nFound ${configs.length} online eval config(s):\n`);
        for (let i = 0; i < configs.length; i++) {
          const c = configs[i]!;
          console.log(
            `  ${dim}[${i + 1}]${reset} ${c.onlineEvaluationConfigName} — ${c.status} (${c.executionStatus})`
          );
          console.log(`       ${dim}${c.onlineEvaluationConfigArn}${reset}`);
        }
        console.log('');

        return failResult(
          logger,
          'Multiple online eval configs found. Use --arn <configArn> to specify which config to import.',
          'online-eval',
          ''
        );
      }
    }

    onProgress(`Fetching online eval config details for ${configId}...`);
    const configDetail = await getOnlineEvaluationConfig({ region: target.region, configId });

    if (configDetail.status !== 'ACTIVE') {
      onProgress(`Warning: Online eval config status is ${configDetail.status}, not ACTIVE`);
    }

    // Derive local name
    const localName = options.name ?? configDetail.configName;
    const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        'online-eval',
        localName
      );
    }
    onProgress(`Online eval config: ${configDetail.configName} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set((projectSpec.onlineEvalConfigs ?? []).map(c => c.name));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `Online eval config "${localName}" already exists in the project. Use --name to specify a different local name.`,
        'online-eval',
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'online-eval', configId);
    if (existingResource) {
      return failResult(
        logger,
        `Online eval config "${configId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`,
        'online-eval',
        localName
      );
    }
    logger.endStep('success');

    // 5. Resolve agent and evaluator references
    logger.startStep('Resolve references');

    // Extract agent name from service names
    const agentName = extractAgentName(configDetail.serviceNames ?? []);
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
    const evaluatorIds = configDetail.evaluatorIds ?? [];
    if (evaluatorIds.length === 0) {
      return failResult(
        logger,
        'Online eval config has no evaluators configured. Cannot import.',
        'online-eval',
        localName
      );
    }
    const evaluatorNames = resolveEvaluatorReferences(evaluatorIds, projectSpec, target.region, target.account);
    onProgress(`Agent: ${agentName}, Evaluators: ${evaluatorNames.join(', ')}`);
    logger.endStep('success');

    // 6. Add to project config
    logger.startStep('Update project config');
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    const onlineEvalSpec = toOnlineEvalConfigSpec(configDetail, localName, agentName, evaluatorNames);
    (projectSpec.onlineEvalConfigs ??= []).push(onlineEvalSpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added online eval config "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 7-10. CDK build → synth → bootstrap → phase 1 → phase 2 → update state
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
        // Try matching by OnlineEvaluationConfigName property
        let logicalId = findLogicalIdByProperty(
          synthTemplate,
          'AWS::BedrockAgentCore::OnlineEvaluationConfig',
          'OnlineEvaluationConfigName',
          localName
        );

        if (!logicalId) {
          const prefixedName = `${ctx.projectName}_${localName}`;
          logicalId = findLogicalIdByProperty(
            synthTemplate,
            'AWS::BedrockAgentCore::OnlineEvaluationConfig',
            'OnlineEvaluationConfigName',
            prefixedName
          );
        }

        // Fall back to single online eval config by type
        if (!logicalId) {
          const configLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::OnlineEvaluationConfig');
          if (configLogicalIds.length === 1) {
            logicalId = configLogicalIds[0];
          }
        }

        if (!logicalId) {
          return [];
        }

        return [
          {
            resourceType: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
            logicalResourceId: logicalId,
            resourceIdentifier: { OnlineEvaluationConfigId: configId },
          },
        ];
      },
      deployedStateEntries: [
        {
          type: 'online-eval',
          name: localName,
          id: configId,
          arn: configDetail.configArn,
        },
      ],
    });

    if (pipelineResult.noResources) {
      const error = `Could not find logical ID for online eval config "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, 'online-eval', localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: 'online-eval',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    logger.finalize(true);
    return {
      success: true,
      resourceType: 'online-eval',
      resourceName: localName,
      resourceId: configId,
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
      resourceType: 'online-eval',
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
    };
  }
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
        console.log(`${green}Online eval config imported successfully!${reset}`);
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
