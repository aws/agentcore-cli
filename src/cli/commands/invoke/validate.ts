import type { InvokeOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateInvokeOptions(options: InvokeOptions): ValidationResult {
  if (options.json && !options.prompt) {
    return { valid: false, error: 'Prompt is required for JSON output' };
  }
  if (options.stream && !options.prompt) {
    return { valid: false, error: 'Prompt is required for streaming' };
  }
  return { valid: true };
}
