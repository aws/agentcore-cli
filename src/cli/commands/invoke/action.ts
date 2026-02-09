import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { invokeAgentRuntime, invokeAgentRuntimeStreaming } from '../../aws';
import { InvokeLogger } from '../../logging';
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

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.agents?.[agentSpec.name];

  if (!agentState) {
    return { success: false, error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke "your prompt"' };
  }

  // Create logger for this invocation
  const logger = new InvokeLogger({
    agentName: agentSpec.name,
    runtimeArn: agentState.runtimeArn,
    region: targetConfig.region,
  });

  logger.logPrompt(options.prompt);

  if (options.stream) {
    // Streaming mode
    let fullResponse = '';
    try {
      const result = await invokeAgentRuntimeStreaming({
        region: targetConfig.region,
        runtimeArn: agentState.runtimeArn,
        payload: options.prompt,
        logger, // Pass logger for SSE event debugging
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
  });

  logger.logResponse(response.content);

  return {
    success: true,
    agentName: agentSpec.name,
    targetName: selectedTargetName,
    response: response.content,
    logFilePath: logger.logFilePath,
  };
}
