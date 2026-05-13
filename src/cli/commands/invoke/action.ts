import { ConfigIO, ResourceNotFoundError, ValidationError } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
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
import { InvokeLogger } from '../../logging';
import { formatMcpToolList } from '../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../operations/fetch-access';
import { generateSessionId } from '../../operations/session';
import type { InvokeOptions, InvokeResult } from './types';

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

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return {
      success: false,
      error: new ResourceNotFoundError('No deployed targets found. Run `agentcore deploy` first.'),
    };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return {
      success: false,
      error: new ResourceNotFoundError(
        `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`
      ),
    };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Target config '${selectedTargetName}' not found in aws-targets`),
    };
  }

  if (project.runtimes.length === 0) {
    return { success: false, error: new ValidationError('No agents defined in configuration') };
  }

  // Resolve agent
  const agentNames = project.runtimes.map(a => a.name);

  if (!options.agentName && project.runtimes.length > 1) {
    return {
      success: false,
      error: new ValidationError(`Multiple runtimes found. Use --runtime to specify one: ${agentNames.join(', ')}`),
    };
  }

  const agentSpec = options.agentName ? project.runtimes.find(a => a.name === options.agentName) : project.runtimes[0];

  if (options.agentName && !agentSpec) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}`),
    };
  }

  if (!agentSpec) {
    return { success: false, error: new ValidationError('No agents defined in configuration') };
  }

  // Warn about VPC mode endpoint requirements
  if (agentSpec.networkMode === 'VPC') {
    console.log(
      '\x1b[33mWarning: This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.\x1b[0m'
    );
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    return {
      success: false,
      error: new ValidationError(`Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'`),
    };
  }

  // Build config bundle baggage if a bundle is associated with this agent
  const deployedBundles = targetState?.resources?.configBundles ?? {};
  let baggage: string | undefined;
  const bundleSpec = project.configBundles?.find(b => {
    const keys = Object.keys(b.components ?? {});
    return keys.some(k => k === `{{runtime:${agentSpec.name}}}`);
  });
  if (bundleSpec) {
    const bundleState = deployedBundles[bundleSpec.name];
    if (bundleState?.bundleArn && bundleState?.versionId) {
      baggage = `aws.agentcore.configbundle_arn=${encodeURIComponent(bundleState.bundleArn)},aws.agentcore.configbundle_version=${encodeURIComponent(bundleState.versionId)}`;
    }
  }

  // Auto-fetch bearer token for CUSTOM_JWT agents when not provided
  if (agentSpec.authorizerType === 'CUSTOM_JWT' && !options.bearerToken) {
    const canFetch = await canFetchRuntimeToken(agentSpec.name);
    if (canFetch) {
      try {
        const tokenResult = await fetchRuntimeToken(agentSpec.name, { deployTarget: selectedTargetName });
        options = { ...options, bearerToken: tokenResult.token };
      } catch (err) {
        return {
          success: false,
          error: new ValidationError(
            `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
            { cause: err }
          ),
        };
      }
    } else {
      return {
        success: false,
        error: new ValidationError(
          `Agent '${agentSpec.name}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the agent with --client-id and --client-secret to enable auto-fetch.`
        ),
      };
    }
  }

  // When invoking with a bearer token (OAuth/CUSTOM_JWT), AgentCore does not
  // auto-generate a runtime session ID the way it does for SigV4 callers. Templates
  // that wire up AgentCoreMemorySessionManager require a non-null session_id, so
  // generate one here if the caller didn't pass --session-id.
  if (options.bearerToken && !options.sessionId) {
    options = { ...options, sessionId: generateSessionId() };
  }

  // Exec mode: run shell command in runtime container
  if (options.exec) {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: agentState.runtimeArn,
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
        runtimeArn: agentState.runtimeArn,
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
      runtimeArn: agentState.runtimeArn,
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
          runtimeArn: agentState.runtimeArn,
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
      runtimeArn: agentState.runtimeArn,
      region: targetConfig.region,
    });

    try {
      const aguiInput = buildAguiRunInput(options.prompt, options.sessionId);
      logger.logPrompt(options.prompt, undefined, options.userId);

      const aguiResult = await invokeAguiRuntime(
        {
          region: targetConfig.region,
          runtimeArn: agentState.runtimeArn,
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
    runtimeArn: agentState.runtimeArn,
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
        runtimeArn: agentState.runtimeArn,
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
    runtimeArn: agentState.runtimeArn,
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
