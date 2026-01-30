import type { Access } from '../../../schema';
import { getErrorMessage } from '../../errors';
import {
  attachAgentToAgent,
  attachGatewayToAgent,
  attachIdentityToAgent,
  attachMemoryToAgent,
  bindMcpRuntimeToAgent,
} from '../../operations/attach';
import type {
  AttachAgentResult,
  AttachGatewayResult,
  AttachIdentityResult,
  AttachMcpRuntimeResult,
  AttachMemoryResult,
} from './types';

// Agent
export interface ValidatedAttachAgentOptions {
  source: string;
  target: string;
  name?: string;
}

export async function handleAttachAgent(options: ValidatedAttachAgentOptions): Promise<AttachAgentResult> {
  try {
    const name = options.name ?? `invoke${options.target}`;
    const config = {
      targetAgent: options.target,
      name,
      description: `Invoke agent ${options.target}`,
      envVarName: `AGENT_${options.target.toUpperCase()}_ARN`,
    };

    await attachAgentToAgent(options.source, config);

    return {
      success: true,
      sourceAgent: options.source,
      targetAgent: options.target,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// Memory
export interface ValidatedAttachMemoryOptions {
  agent: string;
  memory: string;
  access?: string;
}

export async function handleAttachMemory(options: ValidatedAttachMemoryOptions): Promise<AttachMemoryResult> {
  try {
    const sanitized = options.memory.toUpperCase().replace(/-/g, '_');
    const config = {
      memoryName: options.memory,
      access: (options.access ?? 'readwrite') as Access,
      envVarName: `AGENTCORE_MEMORY_${sanitized}_ID`,
    };

    await attachMemoryToAgent(options.agent, config);

    return {
      success: true,
      agentName: options.agent,
      memoryName: options.memory,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// Identity
export interface ValidatedAttachIdentityOptions {
  agent: string;
  identity: string;
}

export async function handleAttachIdentity(options: ValidatedAttachIdentityOptions): Promise<AttachIdentityResult> {
  try {
    const sanitized = options.identity.toUpperCase().replace(/-/g, '_');
    const config = {
      identityName: options.identity,
      envVarName: `AGENTCORE_IDENTITY_${sanitized}_ID`,
    };

    await attachIdentityToAgent(options.agent, config);

    return {
      success: true,
      agentName: options.agent,
      identityName: options.identity,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// MCP Runtime
export interface ValidatedAttachMcpRuntimeOptions {
  agent: string;
  runtime: string;
}

export async function handleAttachMcpRuntime(
  options: ValidatedAttachMcpRuntimeOptions
): Promise<AttachMcpRuntimeResult> {
  try {
    const sanitized = options.runtime.toUpperCase().replace(/-/g, '_');
    const config = {
      agentName: options.agent,
      envVarName: `MCPRUNTIME_${sanitized}_ARN`,
    };

    await bindMcpRuntimeToAgent(options.runtime, config);

    return {
      success: true,
      agentName: options.agent,
      runtimeName: options.runtime,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

// Gateway
export interface ValidatedAttachGatewayOptions {
  agent: string;
  gateway: string;
}

export async function handleAttachGateway(options: ValidatedAttachGatewayOptions): Promise<AttachGatewayResult> {
  try {
    const sanitized = options.gateway.toUpperCase().replace(/-/g, '_');
    const config = {
      gatewayName: options.gateway,
      name: `gateway${options.gateway}`,
      description: `Access gateway ${options.gateway}`,
      envVarName: `AGENTCORE_GATEWAY_${sanitized}_URL`,
    };

    await attachGatewayToAgent(options.agent, config);

    return {
      success: true,
      agentName: options.agent,
      gatewayName: options.gateway,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
