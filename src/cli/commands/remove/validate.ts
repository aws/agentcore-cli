import type { RemoveAllOptions, RemoveOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateRemoveOptions(options: RemoveOptions): ValidationResult {
  if (options.json && !options.name) {
    return { valid: false, error: '--name is required for JSON output' };
  }
  return { valid: true };
}

export function validateRemoveAllOptions(_options: RemoveAllOptions): ValidationResult {
  return { valid: true };
}
