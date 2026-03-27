import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import {
  invokeA2ARuntime,
  invokeAgentRuntime,
  invokeAgentRuntimeStreaming,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
} from '../../aws';
import { InvokeLogger } from '../../logging';
import { formatMcpToolList } from '../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../operations/fetch-access';
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
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  if (project.agents.length === 0) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Resolve agent
  const agentNames = project.agents.map(a => a.name);

  if (!options.agentName && project.agents.length > 1) {
    return { success: false, error: `Multiple agents found. Use --agent to specify one: ${agentNames.join(', ')}` };
  }

  const agentSpec = options.agentName ? project.agents.find(a => a.name === options.agentName) : project.agents[0];

  if (options.agentName && !agentSpec) {
    return { success: false, error: `Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}` };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Warn about VPC mode endpoint requirements
  if (agentSpec.networkMode === 'VPC') {
    console.log(
      '\x1b[33mWarning: This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.\x1b[0m'
    );
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.agents?.[agentSpec.name];

  if (!agentState) {
    return { success: false, error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
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
          error: `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
        };
      }
    }
  }

  // MCP protocol handling
  if (agentSpec.protocol === 'MCP') {
    const mcpOpts = {
      region: targetConfig.region,
      runtimeArn: agentState.runtimeArn,
      userId: options.userId,
      headers: options.headers,
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
          error: `Failed to list MCP tools: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // call-tool: call an MCP tool by name
    if (options.prompt === 'call-tool') {
      if (!options.tool) {
        return {
          success: false,
          error: 'MCP call-tool requires --tool <name>. Use "list-tools" to see available tools.',
        };
      }
      let args: Record<string, unknown> = {};
      if (options.input) {
        try {
          args = JSON.parse(options.input) as Record<string, unknown>;
        } catch {
          return { success: false, error: `Invalid JSON for --input: ${options.input}` };
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
          error: `Failed to call MCP tool: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!options.prompt) {
      return {
        success: false,
        error:
          'MCP agents require a command. Usage:\n  agentcore invoke list-tools\n  agentcore invoke call-tool --tool <name> --input \'{"arg": "value"}\'',
      };
    }
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke "your prompt"' };
  }

  // A2A protocol handling — send JSON-RPC message/send via InvokeAgentRuntime
  if (agentSpec.protocol === 'A2A') {
    try {
      const a2aResult = await invokeA2ARuntime(
        {
          region: targetConfig.region,
          runtimeArn: agentState.runtimeArn,
          userId: options.userId,
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
      return { success: false, error: `A2A invoke failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // modelProvider has been removed from schema
  const providerInfo = undefined;

  // Create logger for this invocation
  const logger = new InvokeLogger({
    agentName: agentSpec.name,
    runtimeArn: agentState.runtimeArn,
    region: targetConfig.region,
  });

  logger.logPrompt(options.prompt, undefined, options.userId);

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
        logFilePath: logger.logFilePath,
        providerInfo,
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
  });

  logger.logResponse(response.content);

  return {
    success: true,
    agentName: agentSpec.name,
    targetName: selectedTargetName,
    response: response.content,
    logFilePath: logger.logFilePath,
    providerInfo,
  };
}
