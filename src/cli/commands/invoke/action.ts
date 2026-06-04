import { ConfigIO, ResourceNotFoundError, ValidationError } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState, HarnessModel } from '../../../schema';
import {
  buildAguiRunInput,
  executeBashCommand,
  invokeA2ARuntime,
  invokeAgentRuntime,
  invokeAgentRuntimeStreaming,
  invokeAguiRuntime,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
} from '../../aws';
import { invokeHarness } from '../../aws/agentcore-harness';
import { ANSI } from '../../constants';
import { isPreviewEnabled } from '../../feature-flags';
import { InvokeLogger } from '../../logging';
import { formatMcpToolList } from '../../operations/dev/utils';
import { canFetchHarnessToken, fetchHarnessToken } from '../../operations/fetch-access';
import { resolveInvokeTarget } from './resolve';
import type { InvokeOptions, InvokeResult } from './types';
import { randomUUID } from 'node:crypto';

export interface InvokeContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

/**
 * Loads configuration required for invocation
 */
export async function loadInvokeConfig(configIO: ConfigIO = new ConfigIO()): Promise<InvokeContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

/**
 * Main invoke handler
 */
export async function handleInvoke(context: InvokeContext, options: InvokeOptions = {}): Promise<InvokeResult> {
  const { project, deployedState, awsTargets } = context;

  // Preview: route to harness before runtime resolution
  if (isPreviewEnabled()) {
    const harnessEntries = project.harnesses ?? [];
    const isHarnessInvoke = options.harnessName != null || (harnessEntries.length > 0 && project.runtimes.length === 0);

    if (isHarnessInvoke) {
      const targetNames = Object.keys(deployedState.targets);
      if (targetNames.length === 0) {
        return {
          success: false,
          error: new ResourceNotFoundError('No deployed targets found. Run `agentcore deploy` first.'),
        };
      }
      const selectedTarget = options.targetName ?? targetNames[0]!;
      if (options.targetName && !targetNames.includes(options.targetName)) {
        return {
          success: false,
          error: new ResourceNotFoundError(
            `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`
          ),
        };
      }
      const targetState = deployedState.targets[selectedTarget];
      const targetConfig = awsTargets.find(t => t.name === selectedTarget);
      if (!targetConfig) {
        return {
          success: false,
          error: new ResourceNotFoundError(`Target config '${selectedTarget}' not found in aws-targets`),
        };
      }
      return handleHarnessInvoke(project, targetState, targetConfig, selectedTarget, options);
    }

    if (harnessEntries.length > 0 && project.runtimes.length > 0 && !options.agentName) {
      const runtimeNames = project.runtimes.map(a => a.name);
      const harnessNames = harnessEntries.map(h => h.name);
      return {
        success: false,
        error: new ValidationError(
          `Project has both runtimes and harnesses. Specify one:\n` +
            `  --runtime: ${runtimeNames.join(', ')}\n` +
            `  --harness: ${harnessNames.join(', ')}`
        ),
      };
    }
  }

  const resolved = await resolveInvokeTarget({
    project,
    deployedState,
    awsTargets,
    agentName: options.agentName,
    targetName: options.targetName,
    bearerToken: options.bearerToken,
    sessionId: options.sessionId,
  });

  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }

  const { agentSpec, targetName: selectedTargetName, targetConfig, runtimeArn, baggage } = resolved;
  options = {
    ...options,
    bearerToken: resolved.bearerToken ?? options.bearerToken,
    sessionId: resolved.sessionId ?? options.sessionId,
  };

  // Warn about VPC mode endpoint requirements
  if (agentSpec.networkMode === 'VPC' && !options.json) {
    console.log(
      `${ANSI.yellow}Warning: This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.${ANSI.reset}`
    );
  }

  // Exec mode: run shell command in runtime container
  if (options.exec) {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: runtimeArn,
      region: targetConfig.region,
      sessionId: options.sessionId,
    });
    const command = options.prompt;
    if (!command) {
      return { success: false, error: new ValidationError('--exec requires a command (prompt)') };
    }
    logger.logPrompt(command, options.sessionId, options.userId);

    try {
      const result = await executeBashCommand({
        region: targetConfig.region,
        runtimeArn: runtimeArn,
        command,
        sessionId: options.sessionId,
        timeout: options.timeout,
        headers: options.headers,
        bearerToken: options.bearerToken,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | undefined;
      let status: string | undefined;

      for await (const event of result.stream) {
        switch (event.type) {
          case 'stdout':
            if (event.data) {
              stdout += event.data;
              if (!options.json) {
                process.stdout.write(event.data);
              }
            }
            break;
          case 'stderr':
            if (event.data) {
              stderr += event.data;
              if (!options.json) {
                process.stderr.write(event.data);
              }
            }
            break;
          case 'stop':
            exitCode = event.exitCode;
            status = event.status;
            break;
        }
      }

      logger.logResponse(stdout || stderr || `exit code: ${exitCode}`);

      if (options.json) {
        if (exitCode === 0) {
          return {
            success: true,
            agentName: agentSpec.name,
            targetName: selectedTargetName,
            response: JSON.stringify({ stdout, stderr, exitCode, status }),
            logFilePath: logger.logFilePath,
          };
        }
        return {
          success: false,
          error: new Error(`Command exited with code ${exitCode}`),
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode === undefined) {
        return {
          success: false,
          error: new Error('Command stream ended without exit code'),
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          error: new Error(`Command exited with code ${exitCode}${status === 'TIMED_OUT' ? ' (timed out)' : ''}`),
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
          logFilePath: logger.logFilePath,
        };
      }

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'exec command failed');
      throw err;
    }
  }

  // MCP protocol handling
  if (agentSpec.protocol === 'MCP') {
    const mcpOpts = {
      region: targetConfig.region,
      runtimeArn: runtimeArn,
      userId: options.userId,
      headers: options.headers,
      bearerToken: options.bearerToken,
      baggage,
    };

    // list-tools: list available MCP tools
    if (options.prompt === 'list-tools') {
      try {
        const result = await mcpListTools(mcpOpts);
        const response = formatMcpToolList(result.tools);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: new Error(`Failed to list MCP tools: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          }),
        };
      }
    }

    // call-tool: call an MCP tool by name
    if (options.prompt === 'call-tool') {
      if (!options.tool) {
        return {
          success: false,
          error: new Error('MCP call-tool requires --tool <name>. Use "list-tools" to see available tools.'),
        };
      }
      let args: Record<string, unknown> = {};
      if (options.input) {
        try {
          args = JSON.parse(options.input) as Record<string, unknown>;
        } catch {
          return { success: false, error: new ValidationError(`Invalid JSON for --input: ${options.input}`) };
        }
      }
      try {
        // Lightweight init to get session ID (no tools/list round-trip)
        const mcpSessionId = await mcpInitSession(mcpOpts);
        const response = await mcpCallTool({ ...mcpOpts, mcpSessionId }, options.tool, args);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: new Error(`Failed to call MCP tool: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          }),
        };
      }
    }

    if (!options.prompt) {
      return {
        success: false,
        error: new ValidationError(
          'MCP agents require a command. Usage:\n  agentcore invoke list-tools\n  agentcore invoke call-tool --tool <name> --input \'{"arg": "value"}\''
        ),
      };
    }
  }

  if (!options.prompt) {
    return { success: false, error: new ValidationError('No prompt provided. Usage: agentcore invoke "your prompt"') };
  }

  // A2A protocol handling — send JSON-RPC message/send via InvokeAgentRuntime
  if (agentSpec.protocol === 'A2A') {
    try {
      const a2aResult = await invokeA2ARuntime(
        {
          region: targetConfig.region,
          runtimeArn: runtimeArn,
          userId: options.userId,
          sessionId: options.sessionId,
          headers: options.headers,
        },
        options.prompt
      );
      let response = '';
      for await (const chunk of a2aResult.stream) {
        response += chunk;
        if (options.stream) {
          process.stdout.write(chunk);
        }
      }
      if (options.stream) {
        process.stdout.write('\n');
      }
      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response,
      };
    } catch (err) {
      return {
        success: false,
        error: new Error(`A2A invoke failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }),
      };
    }
  }

  // AGUI protocol handling — send RunAgentInput via InvokeAgentRuntime, stream text
  if (agentSpec.protocol === 'AGUI') {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: runtimeArn,
      region: targetConfig.region,
    });

    try {
      const aguiInput = buildAguiRunInput(options.prompt, options.sessionId);
      logger.logPrompt(options.prompt, undefined, options.userId);

      const aguiResult = await invokeAguiRuntime(
        {
          region: targetConfig.region,
          runtimeArn: runtimeArn,
          sessionId: options.sessionId,
          userId: options.userId,
          logger,
          headers: options.headers,
          bearerToken: options.bearerToken,
        },
        aguiInput
      );
      let response = '';
      let hasError = false;
      for await (const chunk of aguiResult.textStream) {
        response += chunk;
        if (chunk.startsWith('Error: ')) {
          hasError = true;
        }
        if (options.stream) {
          process.stdout.write(chunk);
        }
      }
      if (options.stream) {
        process.stdout.write('\n');
      }

      logger.logResponse(response);

      if (hasError) {
        return {
          success: false,
          error: new Error(response),
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
          sessionId: aguiResult.sessionId,
          logFilePath: logger.logFilePath,
        };
      }

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response,
        sessionId: aguiResult.sessionId,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'AGUI invoke failed');
      return {
        success: false,
        error: new Error(`AGUI invoke failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }),
      };
    }
  }

  // Create logger for this invocation
  const logger = new InvokeLogger({
    agentName: agentSpec.name,
    runtimeArn: runtimeArn,
    region: targetConfig.region,
    sessionId: options.sessionId,
  });

  logger.logPrompt(options.prompt, options.sessionId, options.userId);

  if (options.stream) {
    // Streaming mode
    let fullResponse = '';
    try {
      const result = await invokeAgentRuntimeStreaming({
        region: targetConfig.region,
        runtimeArn: runtimeArn,
        payload: options.prompt,
        sessionId: options.sessionId,
        userId: options.userId,
        logger,
        headers: options.headers,
        bearerToken: options.bearerToken,
        baggage,
      });

      for await (const chunk of result.stream) {
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');

      logger.logResponse(fullResponse);

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response: fullResponse,
        sessionId: result.sessionId,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'invoke streaming failed');
      throw err;
    }
  }

  // Non-streaming mode
  const response = await invokeAgentRuntime({
    region: targetConfig.region,
    runtimeArn: runtimeArn,
    payload: options.prompt,
    sessionId: options.sessionId,
    userId: options.userId,
    headers: options.headers,
    bearerToken: options.bearerToken,
    baggage,
  });

  logger.logResponse(response.content);

  return {
    success: true,
    agentName: agentSpec.name,
    targetName: selectedTargetName,
    response: response.content,
    sessionId: response.sessionId,
    logFilePath: logger.logFilePath,
  };
}

// ============================================================================
// Harness Invoke (preview mode)
// ============================================================================

export function buildHarnessBaseOpts(
  options: InvokeOptions,
  harnessSpec?: Partial<HarnessModel>
): Partial<import('../../aws/agentcore-harness').InvokeHarnessOptions> {
  const baseOpts: Partial<import('../../aws/agentcore-harness').InvokeHarnessOptions> = {};
  if (options.modelId || options.modelProvider || options.apiKeyArn) {
    const provider = options.modelProvider ?? harnessSpec?.provider;
    const modelId = options.modelId ?? harnessSpec?.modelId ?? '';
    const apiKeyArn = options.apiKeyArn ?? harnessSpec?.apiKeyArn;
    switch (provider) {
      case 'open_ai':
        baseOpts.model = {
          openAiModelConfig: { modelId, ...(apiKeyArn && { apiKeyArn }) },
        };
        break;
      case 'gemini':
        baseOpts.model = {
          geminiModelConfig: { modelId, ...(apiKeyArn && { apiKeyArn }) },
        };
        break;
      default:
        baseOpts.model = {
          bedrockModelConfig: { modelId },
        };
        break;
    }
  }
  if (options.tools) {
    baseOpts.tools = options.tools.split(',').map(t => {
      const type = t.trim();
      return { type, name: type };
    });
  }
  if (options.maxIterations != null) baseOpts.maxIterations = options.maxIterations;
  if (options.maxTokens != null) baseOpts.maxTokens = options.maxTokens;
  if (options.harnessTimeout != null) baseOpts.timeoutSeconds = options.harnessTimeout;
  if (options.skills) baseOpts.skills = options.skills.split(',').map(p => ({ path: p.trim() }));
  if (options.systemPrompt) baseOpts.systemPrompt = [{ text: options.systemPrompt }];
  if (options.allowedTools) baseOpts.allowedTools = options.allowedTools.split(',').map(t => t.trim());
  if (options.actorId) baseOpts.actorId = options.actorId;
  return baseOpts;
}

export async function handleHarnessInvokeByArn(
  harnessArn: string,
  region: string,
  options: InvokeOptions
): Promise<InvokeResult> {
  if (!options.prompt) {
    return {
      success: false,
      error: new ValidationError(
        'No prompt provided. Usage: agentcore invoke --harness-arn <arn> --region <region> "your prompt"'
      ),
    };
  }

  const sessionId = options.sessionId ?? randomUUID();
  const logger = new InvokeLogger({ agentName: 'external-harness', runtimeArn: harnessArn, region, sessionId });
  logger.logPrompt(options.prompt, sessionId, options.userId);

  const baseOpts = buildHarnessBaseOpts(options);
  return streamHarnessInvoke({ region, harnessArn, sessionId, prompt: options.prompt, options, logger, baseOpts });
}

interface StreamHarnessParams {
  region: string;
  harnessArn: string;
  sessionId: string;
  prompt: string;
  options: InvokeOptions;
  logger: InvokeLogger;
  baseOpts: Partial<import('../../aws/agentcore-harness').InvokeHarnessOptions>;
}

async function streamHarnessInvoke(params: StreamHarnessParams): Promise<InvokeResult> {
  const { region, harnessArn, sessionId, prompt, options, logger, baseOpts } = params;
  let fullResponse = '';

  try {
    const messages: { role: string; content: Record<string, unknown>[] }[] = [
      { role: 'user', content: [{ text: prompt }] },
    ];

    const stream = invokeHarness({
      region,
      harnessArn,
      runtimeSessionId: sessionId,
      messages,
      bearerToken: options.bearerToken,
      ...baseOpts,
    });

    for await (const event of stream) {
      if (options.verbose) {
        console.log(JSON.stringify(event));
        continue;
      }

      switch (event.type) {
        case 'contentBlockDelta':
          if (event.delta.type === 'text') {
            fullResponse += event.delta.text;
            if (!options.json) {
              process.stdout.write(event.delta.text);
            }
          }
          break;
        case 'messageStop':
          if (!options.json && event.stopReason !== 'tool_use' && event.stopReason !== 'tool_result') {
            process.stdout.write('\n');
          }
          break;
        case 'error':
          logger.logError(new Error(`${event.errorType}: ${event.message}`), 'stream error');
          if (options.json) {
            return { success: false, error: new Error(`${event.errorType}: ${event.message}`) };
          }
          process.stderr.write(`\nError: ${event.message}\n`);
          break;
      }
    }

    logger.logResponse(fullResponse);

    if (options.json) {
      return {
        success: true,
        response: JSON.stringify({ text: fullResponse, sessionId }),
        sessionId,
        logFilePath: logger.logFilePath,
      };
    }

    return { success: true, sessionId, logFilePath: logger.logFilePath };
  } catch (err) {
    logger.logError(err, 'harness invoke failed');
    return {
      success: false,
      error: new Error(`Harness invoke failed: ${err instanceof Error ? err.message : String(err)}`),
      logFilePath: logger.logFilePath,
    };
  }
}

async function handleHarnessInvoke(
  project: AgentCoreProjectSpec,
  targetState: DeployedState['targets'][string] | undefined,
  targetConfig: { region: string; name: string },
  selectedTargetName: string,
  options: InvokeOptions
): Promise<InvokeResult> {
  const harnessEntries = project.harnesses ?? [];

  if (harnessEntries.length === 0) {
    return { success: false, error: new ValidationError('No harnesses defined in configuration') };
  }

  let harnessName = options.harnessName;
  if (!harnessName) {
    if (harnessEntries.length > 1) {
      const names = harnessEntries.map(h => h.name);
      return {
        success: false,
        error: new ValidationError(`Multiple harnesses found. Use --harness to specify one: ${names.join(', ')}`),
      };
    }
    harnessName = harnessEntries[0]!.name;
  }

  const harnessEntry = harnessEntries.find(h => h.name === harnessName);
  if (!harnessEntry) {
    const names = harnessEntries.map(h => h.name);
    return {
      success: false,
      error: new ResourceNotFoundError(`Harness '${harnessName}' not found. Available: ${names.join(', ')}`),
    };
  }

  const harnessState = targetState?.resources?.harnesses?.[harnessName];
  if (!harnessState) {
    return {
      success: false,
      error: new ValidationError(
        `Harness '${harnessName}' is not deployed to target '${selectedTargetName}'. Run \`agentcore deploy\` first.`
      ),
    };
  }

  const sessionId = options.sessionId ?? randomUUID();
  const region = targetConfig.region;

  const logger = new InvokeLogger({
    agentName: harnessName,
    runtimeArn: harnessState.harnessArn,
    region,
    sessionId,
  });

  // Read harness spec for auth config
  const configIO = new ConfigIO();
  let harnessSpec;
  try {
    harnessSpec = await configIO.readHarnessSpec(harnessName);
  } catch {
    // spec read is best-effort
  }

  // Auto-fetch bearer token for CUSTOM_JWT harnesses
  if (harnessSpec?.authorizerType === 'CUSTOM_JWT' && !options.bearerToken) {
    const canFetch = await canFetchHarnessToken(harnessName);
    if (canFetch) {
      try {
        const tokenResult = await fetchHarnessToken(harnessName, { deployTarget: selectedTargetName });
        options = { ...options, bearerToken: tokenResult.token };
      } catch (err) {
        return {
          success: false,
          error: new ValidationError(
            `CUSTOM_JWT harness requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`
          ),
        };
      }
    } else {
      return {
        success: false,
        error: new ValidationError(
          `Harness '${harnessName}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the harness with --client-id and --client-secret to enable auto-fetch.`
        ),
      };
    }
  }

  if (!options.prompt) {
    return {
      success: false,
      error: new ValidationError('No prompt provided. Usage: agentcore invoke --harness <name> "your prompt"'),
    };
  }

  logger.logPrompt(options.prompt, sessionId, options.userId);

  const baseOpts = buildHarnessBaseOpts(options, harnessSpec?.model);

  const result = await streamHarnessInvoke({
    region,
    harnessArn: harnessState.harnessArn,
    sessionId,
    prompt: options.prompt,
    options,
    logger,
    baseOpts,
  });

  return { ...result, targetName: selectedTargetName };
}
