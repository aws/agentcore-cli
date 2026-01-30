import type {
  AttachAgentOptions,
  AttachGatewayOptions,
  AttachIdentityOptions,
  AttachMcpRuntimeOptions,
  AttachMemoryOptions,
} from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateAttachAgentOptions(options: AttachAgentOptions): ValidationResult {
  if (!options.source) {
    return { valid: false, error: '--source is required' };
  }

  if (!options.target) {
    return { valid: false, error: '--target is required' };
  }

  return { valid: true };
}

export function validateAttachMemoryOptions(options: AttachMemoryOptions): ValidationResult {
  if (!options.agent) {
    return { valid: false, error: '--agent is required' };
  }

  if (!options.memory) {
    return { valid: false, error: '--memory is required' };
  }

  if (options.access && options.access !== 'read' && options.access !== 'readwrite') {
    return { valid: false, error: 'Invalid access. Must be read or readwrite' };
  }

  return { valid: true };
}

export function validateAttachIdentityOptions(options: AttachIdentityOptions): ValidationResult {
  if (!options.agent) {
    return { valid: false, error: '--agent is required' };
  }

  if (!options.identity) {
    return { valid: false, error: '--identity is required' };
  }

  return { valid: true };
}

export function validateAttachMcpRuntimeOptions(options: AttachMcpRuntimeOptions): ValidationResult {
  if (!options.agent) {
    return { valid: false, error: '--agent is required' };
  }

  if (!options.runtime) {
    return { valid: false, error: '--runtime is required' };
  }

  return { valid: true };
}

export function validateAttachGatewayOptions(options: AttachGatewayOptions): ValidationResult {
  if (!options.agent) {
    return { valid: false, error: '--agent is required' };
  }

  if (!options.gateway) {
    return { valid: false, error: '--gateway is required' };
  }

  return { valid: true };
}
