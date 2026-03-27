import { ConfigIO } from '../../../lib';
import { randomUUID } from 'crypto';

/**
 * Generate a new session ID using UUID v4.
 */
export function generateSessionId(): string {
  return randomUUID();
}

export interface SessionInfo {
  sessionId: string | undefined;
  agentName: string;
  runtimeArn: string;
  targetName: string;
}

/**
 * Get the session ID for an agent from the deployed state.
 */
export async function getSessionId(
  agentName: string,
  targetName?: string,
  configIO: ConfigIO = new ConfigIO()
): Promise<SessionInfo | null> {
  const deployedState = await configIO.readDeployedState();
  const awsTargets = await configIO.readAWSDeploymentTargets();

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return null;
  }

  const selectedTargetName = targetName ?? targetNames[0]!;
  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig || !targetState?.resources?.runtimes) {
    return null;
  }

  const agentState = targetState.resources.runtimes[agentName];
  if (!agentState) {
    return null;
  }

  return {
    sessionId: agentState.sessionId,
    agentName,
    runtimeArn: agentState.runtimeArn,
    targetName: selectedTargetName,
  };
}

/**
 * Save a session ID for an agent to the deployed state.
 */
export async function saveSessionId(
  agentName: string,
  sessionId: string,
  targetName?: string,
  configIO: ConfigIO = new ConfigIO()
): Promise<void> {
  const deployedState = await configIO.readDeployedState();

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found');
  }

  const selectedTargetName = targetName ?? targetNames[0]!;
  const targetState = deployedState.targets[selectedTargetName];

  if (!targetState?.resources?.runtimes?.[agentName]) {
    throw new Error(`Agent '${agentName}' not found in deployed state`);
  }

  // Update the session ID
  targetState.resources.runtimes[agentName].sessionId = sessionId;

  await configIO.writeDeployedState(deployedState);
}

/**
 * Clear the session ID for an agent from the deployed state.
 */
export async function clearSessionId(
  agentName: string,
  targetName?: string,
  configIO: ConfigIO = new ConfigIO()
): Promise<void> {
  const deployedState = await configIO.readDeployedState();

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return;
  }

  const selectedTargetName = targetName ?? targetNames[0]!;
  const targetState = deployedState.targets[selectedTargetName];

  if (!targetState?.resources?.runtimes?.[agentName]) {
    return;
  }

  // Clear the session ID
  delete targetState.resources.runtimes[agentName].sessionId;

  await configIO.writeDeployedState(deployedState);
}

/**
 * Get or create a session ID for an agent.
 * If a session ID exists in the deployed state, returns it.
 * Otherwise, generates a new one and saves it.
 */
export async function getOrCreateSessionId(
  agentName: string,
  targetName?: string,
  configIO: ConfigIO = new ConfigIO()
): Promise<string> {
  const sessionInfo = await getSessionId(agentName, targetName, configIO);

  if (sessionInfo?.sessionId) {
    return sessionInfo.sessionId;
  }

  const newSessionId = generateSessionId();
  await saveSessionId(agentName, newSessionId, targetName, configIO);

  return newSessionId;
}
