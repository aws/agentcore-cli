import type { AgentEnvSpec } from '../../../schema';
import type { AgentRuntimeDetail, AgentRuntimeSummary } from '../../aws/agentcore-control';
import { getAgentRuntimeDetail, listAllAgentRuntimes } from '../../aws/agentcore-control';
import { ANSI } from './constants';
import { copyAgentSource, failResult, parseAndValidateArn } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceResult, ResourceImportDescriptor, RuntimeImportOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * Create a runtime descriptor with closed-over state for entrypoint, code location, and rollback.
 */
function createRuntimeDescriptor(
  options: RuntimeImportOptions
): ResourceImportDescriptor<AgentRuntimeDetail, AgentRuntimeSummary> {
  let resolvedEntrypoint = '';
  let resolvedCodeLocation = '';
  let copiedAppDir: string | undefined;

  return {
    resourceType: 'runtime',
    displayName: 'runtime',
    logCommand: 'import-runtime',

    listResources: region => listAllAgentRuntimes({ region }),
    getDetail: (region, id) => getAgentRuntimeDetail({ region, runtimeId: id }),
    parseResourceId: (arn, target) => parseAndValidateArn(arn, 'runtime', target).resourceId,

    extractSummaryId: s => s.agentRuntimeId,
    formatListItem: (s, i) =>
      `  ${ANSI.dim}[${i + 1}]${ANSI.reset} ${s.agentRuntimeName} — ${s.status}\n       ${ANSI.dim}${s.agentRuntimeArn}${ANSI.reset}`,
    formatAutoSelectMessage: s => `Found 1 runtime: ${s.agentRuntimeName} (${s.agentRuntimeId}). Auto-selecting.`,

    extractDetailName: d => d.agentRuntimeName,
    extractDetailArn: d => d.agentRuntimeArn,
    readyStatus: 'READY',
    extractDetailStatus: d => d.status,

    getExistingNames: spec => spec.runtimes.map(r => r.name),
    addToProjectSpec: (detail, localName, spec) => {
      spec.runtimes.push(toAgentEnvSpec(detail, localName, resolvedCodeLocation, resolvedEntrypoint));
    },

    cfnResourceType: 'AWS::BedrockAgentCore::Runtime',
    cfnNameProperty: 'AgentRuntimeName',
    cfnIdentifierKey: 'AgentRuntimeId',

    buildDeployedStateEntry: (name, id, d) => ({ type: 'runtime', name, id, arn: d.agentRuntimeArn }),

    beforeConfigWrite: async ({ detail, localName, ctx, onProgress, logger }) => {
      // Resolve entrypoint
      logger.startStep('Resolve entrypoint');
      const entrypoint = options.entrypoint ?? extractEntrypoint(detail.entryPoint);
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

      // Validate source path
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

      // Copy agent source
      logger.startStep('Copy agent source');
      resolvedCodeLocation = `app/${localName}/`;
      resolvedEntrypoint = entrypoint;
      copiedAppDir = path.join(ctx.projectRoot, 'app', localName);
      await copyAgentSource({
        sourcePath,
        agentName: localName,
        projectRoot: ctx.projectRoot,
        build: detail.build,
        entrypoint,
        onProgress,
      });
      logger.endStep('success');
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    rollbackExtra: async () => {
      if (copiedAppDir && fs.existsSync(copiedAppDir)) {
        try {
          fs.rmSync(copiedAppDir, { recursive: true, force: true });
        } catch (err) {
          console.warn(
            `Warning: Could not clean up ${copiedAppDir}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
  };
}

/**
 * Handle `agentcore import runtime`.
 */
export async function handleImportRuntime(options: RuntimeImportOptions): Promise<ImportResourceResult> {
  return executeResourceImport(createRuntimeDescriptor(options), options);
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
    .action(async (cliOptions: RuntimeImportOptions) => {
      const result = await handleImportRuntime(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${ANSI.green}Runtime imported successfully!${ANSI.reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
        console.log(`${ANSI.dim}Next steps:${ANSI.reset}`);
        console.log(`  agentcore deploy     ${ANSI.dim}Deploy the imported stack${ANSI.reset}`);
        console.log(`  agentcore status     ${ANSI.dim}Verify resource status${ANSI.reset}`);
        console.log(`  agentcore invoke     ${ANSI.dim}Test your agent${ANSI.reset}`);
        console.log('');
      } else {
        console.error(`\n${ANSI.red}[error]${ANSI.reset} ${result.error.message}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
