import type { DeployOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateDeployOptions(_options: DeployOptions): ValidationResult {
  // Target should always be set (defaulted to 'default' by command handler)
  return { valid: true };
}
