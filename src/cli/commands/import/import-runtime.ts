import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../../schema';
import type { AgentRuntimeDetail } from '../../aws/agentcore-control';
import { getAgentRuntimeDetail, listAllAgentRuntimes } from '../../aws/agentcore-control';
import { executeCdkImportPipeline } from './import-pipeline';
import {
  copyAgentSource,
  failResult,
  findResourceInDeployedState,
  parseAndValidateArn,
  resolveImportContext,
  toStackName,
} from './import-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult } from './types';
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
  const runtimeVersion =
    runtime.build === 'Container' ? runtime.runtimeVersion : (runtime.runtimeVersion ?? 'PYTHON_3_12');
  const spec: AgentEnvSpec = {
    name: localName,
    ...(runtime.description && { description: runtime.description }),
    build: runtime.build,
    entrypoint: entrypoint as any,
    codeLocation: codeLocation as any,
    runtimeVersion: runtimeVersion as any,
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

  if (runtime.environmentVariables && Object.keys(runtime.environmentVariables).length > 0) {
    spec.envVars = Object.entries(runtime.environmentVariables).map(([name, value]) => ({ name, value }));
  }

  if (runtime.tags && Object.keys(runtime.tags).length > 0) {
    spec.tags = runtime.tags;
  }

  if (runtime.lifecycleConfiguration) {
    spec.lifecycleConfiguration = runtime.lifecycleConfiguration;
  }

  if (runtime.requestHeaderAllowlist && runtime.requestHeaderAllowlist.length > 0) {
    spec.requestHeaderAllowlist = runtime.requestHeaderAllowlist;
  }

  return spec;
}

/**
 * Handle `agentcore import runtime`.
 */
export async function handleImportRuntime(options: ImportResourceOptions): Promise<ImportResourceResult> {
  // Rollback state
  let configSnapshot: AgentCoreProjectSpec | undefined;
  let configWritten = false;
  let copiedAppDir: string | undefined;

  let importCtx: Awaited<ReturnType<typeof resolveImportContext>> | undefined;

  const rollback = async () => {
    if (configWritten && configSnapshot && importCtx) {
      try {
        await importCtx.ctx.configIO.writeProjectSpec(configSnapshot);
      } catch (err) {
        console.warn(`Warning: Could not restore agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (copiedAppDir && fs.existsSync(copiedAppDir)) {
      try {
        fs.rmSync(copiedAppDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `Warning: Could not clean up ${copiedAppDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };

  try {
    // 1-2. Validate project context and resolve target
    importCtx = await resolveImportContext(options, 'import-runtime');
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Get runtime details from AWS
    logger.startStep('Fetch runtime from AWS');
    let runtimeId: string;

    if (options.arn) {
      const parsed = parseAndValidateArn(options.arn, 'runtime', target);
      runtimeId = parsed.resourceId;
    } else {
      // List runtimes and let user pick
      onProgress('Listing runtimes in your account...');
      const runtimes = await listAllAgentRuntimes({ region: target.region });

      if (runtimes.length === 0) {
        return failResult(logger, 'No runtimes found in your account. Deploy a runtime first.', 'runtime', '');
      }

      if (runtimes.length === 1) {
        runtimeId = runtimes[0]!.agentRuntimeId;
        onProgress(`Found 1 runtime: ${runtimes[0]!.agentRuntimeName} (${runtimeId}). Auto-selecting.`);
      } else {
        console.log(`\nFound ${runtimes.length} runtime(s):\n`);
        for (let i = 0; i < runtimes.length; i++) {
          const r = runtimes[i]!;
          console.log(`  ${dim}[${i + 1}]${reset} ${r.agentRuntimeName} — ${r.status}`);
          console.log(`       ${dim}${r.agentRuntimeArn}${reset}`);
        }
        console.log('');

        return failResult(
          logger,
          'Multiple runtimes found. Use --arn <runtimeArn> to specify which runtime to import.',
          'runtime',
          ''
        );
      }
    }

    onProgress(`Fetching runtime details for ${runtimeId}...`);
    const runtimeDetail = await getAgentRuntimeDetail({ region: target.region, runtimeId });

    if (runtimeDetail.status !== 'READY') {
      onProgress(`Warning: Runtime status is ${runtimeDetail.status}, not READY`);
    }

    // Derive local name
    let localName = options.name ?? runtimeDetail.agentRuntimeName;
    const prefix = `${ctx.projectName}_`;
    if (localName.startsWith(prefix)) {
      localName = localName.slice(prefix.length);
    }
    const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        'runtime',
        localName
      );
    }
    onProgress(`Runtime: ${runtimeDetail.agentRuntimeName} → local name: ${localName}`);
    logger.endStep('success');

    // 4. Resolve entrypoint
    logger.startStep('Resolve entrypoint');
    const entrypoint = options.entrypoint ?? extractEntrypoint(runtimeDetail.entryPoint);
    if (!entrypoint) {
      return failResult(
        logger,
        'Could not determine entrypoint from runtime configuration.\n  Please re-run with --entrypoint <file> to specify it manually.',
        'runtime',
        localName
      );
    }
    onProgress(`Entrypoint: ${entrypoint}`);
    logger.endStep('success');

    // 5. Validate source path
    logger.startStep('Validate source path');
    if (!options.code) {
      return failResult(
        logger,
        'Source path is required for runtime import. Use --code <path> to specify the agent source code directory.',
        'runtime',
        localName
      );
    }

    const sourcePath = path.resolve(options.code);
    if (!fs.existsSync(sourcePath)) {
      return failResult(logger, `Source path does not exist: ${sourcePath}`, 'runtime', localName);
    }
    const entrypointPath = path.join(sourcePath, entrypoint);
    if (!fs.existsSync(entrypointPath)) {
      return failResult(
        logger,
        `Entrypoint file '${entrypoint}' not found in ${sourcePath}. Ensure --code points to the directory containing your entrypoint file.`,
        'runtime',
        localName
      );
    }
    logger.endStep('success');

    // 6. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set(projectSpec.runtimes.map(r => r.name));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `Runtime "${localName}" already exists in the project. Use --name to specify a different local name.`,
        'runtime',
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(ctx.configIO, targetName, 'runtime', runtimeId);
    if (existingResource) {
      return failResult(
        logger,
        `Runtime "${runtimeId}" is already imported in this project as "${existingResource}". Remove it first before re-importing.`,
        'runtime',
        localName
      );
    }
    logger.endStep('success');

    // 7. Copy source code
    logger.startStep('Copy agent source');
    const codeLocation = `app/${localName}/`;
    copiedAppDir = path.join(ctx.projectRoot, 'app', localName);
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
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    const agentSpec = toAgentEnvSpec(runtimeDetail, localName, codeLocation, entrypoint);
    projectSpec.runtimes.push(agentSpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added runtime "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 9-13. CDK build → synth → bootstrap → phase 1 → phase 2 → update state
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
          return [];
        }

        return [
          {
            resourceType: 'AWS::BedrockAgentCore::Runtime',
            logicalResourceId: logicalId,
            resourceIdentifier: { AgentRuntimeId: runtimeId },
          },
        ];
      },
      deployedStateEntries: [
        {
          type: 'runtime',
          name: localName,
          id: runtimeId,
          arn: runtimeDetail.agentRuntimeArn,
        },
      ],
    });

    if (pipelineResult.noResources) {
      const error = `Could not find logical ID for runtime "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, 'runtime', localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: 'runtime',
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
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
    await rollback();
    if (importCtx) {
      importCtx.logger.log(message, 'error');
      importCtx.logger.finalize(false);
    }
    return {
      success: false,
      error: message,
      resourceType: 'runtime',
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
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
    .option('--code <path>', 'Path to the directory containing the entrypoint file (e.g., the folder with main.py)')
    .option('--entrypoint <file>', 'Entrypoint file (auto-detected from runtime, e.g. main.py)')
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
