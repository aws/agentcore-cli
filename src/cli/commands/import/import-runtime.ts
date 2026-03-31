import type { AgentEnvSpec } from '../../../schema';
import type { AgentRuntimeDetail } from '../../aws/agentcore-control';
import { getAgentRuntimeDetail, listAgentRuntimes } from '../../aws/agentcore-control';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { silentIoHost } from '../../cdk/toolkit-lib';
import { ExecLogger } from '../../logging';
import { bootstrapEnvironment, buildCdkProject, checkBootstrapNeeded, synthesizeCdk } from '../../operations/deploy';
import {
  copyAgentSource,
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
 * Extract the actual entrypoint file from the runtime's entryPoint array.
 * The array may contain wrapper commands like "opentelemetry-instrument"
 * before the actual Python/TS file (e.g. ["opentelemetry-instrument", "main.py"]).
 */
export function extractEntrypoint(entryPoint?: string[]): string | undefined {
  if (!entryPoint || entryPoint.length === 0) return undefined;
  // Find the first entry that looks like a source file
  return entryPoint.find(e => /\.(py|ts|js)$/.test(e));
}

/**
 * Map an AWS GetAgentRuntime response to the CLI AgentEnvSpec format.
 */
function toAgentEnvSpec(
  runtime: AgentRuntimeDetail,
  localName: string,
  codeLocation: string,
  entrypoint: string
): AgentEnvSpec {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
  const spec: AgentEnvSpec = {
    name: localName,
    build: runtime.build,
    entrypoint: entrypoint as any,
    codeLocation: codeLocation as any,
    runtimeVersion: (runtime.runtimeVersion ?? 'PYTHON_3_12') as any,
    protocol: runtime.protocol as any,
    networkMode: runtime.networkMode as any,
    instrumentation: { enableOtel: true },
  };
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

  if (runtime.networkMode === 'VPC' && runtime.networkConfig) {
    spec.networkConfig = runtime.networkConfig;
  }

  if (runtime.roleArn && runtime.roleArn !== 'imported') {
    spec.executionRoleArn = runtime.roleArn;
  }

  if (runtime.authorizerType) {
    spec.authorizerType = runtime.authorizerType as AgentEnvSpec['authorizerType'];
  }
  if (runtime.authorizerConfiguration) {
    spec.authorizerConfiguration = runtime.authorizerConfiguration as AgentEnvSpec['authorizerConfiguration'];
  }

  return spec;
}

/**
 * Handle `agentcore import runtime`.
 */
export async function handleImportRuntime(options: ImportResourceOptions): Promise<ImportResourceResult> {
  const logger = new ExecLogger({ command: 'import-runtime' });
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

    // 3. Get runtime details from AWS
    logger.startStep('Fetch runtime from AWS');
    let runtimeId: string;

    if (options.arn) {
      const parsed = parseAndValidateArn(options.arn, 'runtime', target);
      runtimeId = parsed.resourceId;
    } else {
      // List runtimes and let user pick
      onProgress('Listing runtimes in your account...');
      const listResult = await listAgentRuntimes({ region: target.region, maxResults: 100 });

      if (listResult.runtimes.length === 0) {
        const error = 'No runtimes found in your account. Deploy a runtime first.';
        logger.endStep('error', error);
        logger.finalize(false);
        return {
          success: false,
          error,
          resourceType: 'runtime',
          resourceName: '',
          logPath: logger.getRelativeLogPath(),
        };
      }

      // Display list for user to pick
      console.log(`\nFound ${listResult.runtimes.length} runtime(s):\n`);
      for (let i = 0; i < listResult.runtimes.length; i++) {
        const r = listResult.runtimes[i]!;
        console.log(`  ${dim}[${i + 1}]${reset} ${r.agentRuntimeName} (${r.agentRuntimeId}) — ${r.status}`);
      }
      console.log('');

      // For non-interactive mode, require --arn
      const error = 'Multiple runtimes found. Use --arn <runtimeArn> to specify which runtime to import.';
      logger.endStep('error', error);
      logger.finalize(false);
      return { success: false, error, resourceType: 'runtime', resourceName: '', logPath: logger.getRelativeLogPath() };
    }

    onProgress(`Fetching runtime details for ${runtimeId}...`);
    const runtimeDetail = await getAgentRuntimeDetail({ region: target.region, runtimeId });

    if (runtimeDetail.status !== 'READY') {
      onProgress(`Warning: Runtime status is ${runtimeDetail.status}, not READY`);
    }

    // Derive local name: strip project prefix if present, or use --name override
    let localName = options.name ?? runtimeDetail.agentRuntimeName;
    // AgentCore runtime names are often prefixed with projectName_ — strip it
    const prefix = `${ctx.projectName}_`;
    if (localName.startsWith(prefix)) {
      localName = localName.slice(prefix.length);
    }
    onProgress(`Runtime: ${runtimeDetail.agentRuntimeName} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Resolve entrypoint
    logger.startStep('Resolve entrypoint');
    const entrypoint = options.entrypoint ?? extractEntrypoint(runtimeDetail.entryPoint);
    if (!entrypoint) {
      const error =
        'Could not determine entrypoint from runtime configuration.\n  Please re-run with --entrypoint <file> to specify it manually.';
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    onProgress(`Entrypoint: ${entrypoint}`);
    logger.endStep('success');

    // 5. Validate source path
    logger.startStep('Validate source path');
    if (!options.code) {
      const error =
        'Source path is required for runtime import. Use --code <path> to specify the agent source code directory.';
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    const sourcePath = path.resolve(options.code);
    if (!fs.existsSync(sourcePath)) {
      const error = `Source path does not exist: ${sourcePath}`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    // Validate entrypoint file exists inside source directory
    const entrypointPath = path.join(sourcePath, entrypoint);
    if (!fs.existsSync(entrypointPath)) {
      const error = `Entrypoint file '${entrypoint}' not found in ${sourcePath}. Ensure --code points to the directory containing your entrypoint file.`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 6. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set(projectSpec.runtimes.map(r => r.name));
    if (existingNames.has(localName)) {
      const error = `Runtime "${localName}" already exists in the project. Use --name to specify a different local name.`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'runtime', runtimeId);
    if (existingResource) {
      const error = `Runtime "${runtimeId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 7. Copy source code
    logger.startStep('Copy agent source');
    const codeLocation = `app/${localName}/`;
    await copyAgentSource({
      sourcePath,
      agentName: localName,
      projectRoot: ctx.projectRoot,
      build: runtimeDetail.build,
      entrypoint,
      onProgress,
    });
    logger.endStep('success');

    // 8. Add to project config
    logger.startStep('Update project config');
    const agentSpec = toAgentEnvSpec(runtimeDetail, localName, codeLocation, entrypoint);
    projectSpec.runtimes.push(agentSpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    onProgress(`Added runtime "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 9. Build and synth CDK
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
          resourceType: 'runtime',
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

    // 10. Publish CDK assets
    logger.startStep('Publish CDK assets');
    onProgress('Publishing CDK assets to S3...');
    await publishCdkAssets(assemblyDirectory, target.region, onProgress);
    logger.endStep('success');

    // 11. Phase 1: Deploy companion resources
    logger.startStep('Phase 1: Deploy companion resources');
    onProgress('Phase 1: Deploying companion resources (IAM roles, policies)...');
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
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 12. Phase 2: Import the runtime resource
    logger.startStep('Phase 2: Import runtime resource');
    onProgress('Reading deployed template...');
    const deployedTemplate = await getDeployedTemplate(target.region, stackName);
    if (!deployedTemplate) {
      const error = 'Could not read deployed template after Phase 1';
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    // Find the logical ID for this runtime in the synth template
    const expectedRuntimeName = `${ctx.projectName}_${localName}`;
    let logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Runtime',
      'AgentRuntimeName',
      expectedRuntimeName
    );

    if (!logicalId) {
      const runtimeLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Runtime');
      if (runtimeLogicalIds.length === 1) {
        logicalId = runtimeLogicalIds[0];
      }
    }

    if (!logicalId) {
      const error = `Could not find logical ID for runtime "${localName}" in CloudFormation template`;
      logger.endStep('error', error);
      logger.finalize(false);
      return {
        success: false,
        error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    const resourcesToImport: ResourceToImport[] = [
      {
        resourceType: 'AWS::BedrockAgentCore::Runtime',
        logicalResourceId: logicalId,
        resourceIdentifier: { AgentRuntimeId: runtimeId },
      },
    ];

    onProgress(`Phase 2: Importing runtime via CloudFormation IMPORT...`);
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
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 13. Update deployed state
    logger.startStep('Update deployed state');
    await updateDeployedState(ctx.configIO, targetName, stackName, [
      {
        type: 'runtime',
        name: localName,
        id: runtimeId,
        arn: runtimeDetail.agentRuntimeArn,
      },
    ]);
    onProgress('Deployed state updated');
    logger.endStep('success');

    logger.finalize(true);
    return {
      success: true,
      resourceType: 'runtime',
      resourceName: localName,
      resourceId: runtimeId,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log(message, 'error');
    logger.finalize(false);
    return {
      success: false,
      error: message,
      resourceType: 'runtime',
      resourceName: options.name ?? '',
      logPath: logger.getRelativeLogPath(),
    };
  }
}

/**
 * Register the `import runtime` subcommand.
 */
export function registerImportRuntime(importCmd: Command): void {
  importCmd
    .command('runtime')
    .description('Import an existing AgentCore Runtime from your AWS account')
    .option('--arn <runtimeArn>', 'Runtime ARN to import')
    .requiredOption(
      '--code <path>',
      'Path to the directory containing the entrypoint file (e.g., the folder with main.py)'
    )
    .option('--entrypoint <file>', 'Entrypoint file (auto-detected from runtime, e.g. main.py)')
    .option('--target <target>', 'Deployment target name')
    .option('--name <name>', 'Local name for the imported runtime')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportRuntime(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${green}Runtime imported successfully!${reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
        console.log(`${dim}Next steps:${reset}`);
        console.log(`  agentcore deploy     ${dim}Deploy the imported stack${reset}`);
        console.log(`  agentcore status     ${dim}Verify resource status${reset}`);
        console.log(`  agentcore invoke     ${dim}Test your agent${reset}`);
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
