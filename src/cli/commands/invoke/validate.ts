import type { InvokeOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateInvokeOptions(options: InvokeOptions): ValidationResult {
  if (options.exec && !options.prompt) {
    return { valid: false, error: 'A command is required with --exec. Usage: agentcore invoke --exec "ls -la"' };
  }
  if (options.exec && (options.tool || options.input)) {
    return { valid: false, error: '--exec cannot be combined with --tool or --input' };
  }
  if (options.exec && options.stream) {
    return { valid: false, error: '--exec already streams output; --stream is not needed' };
  }
  if (options.json && !options.prompt) {
    return { valid: false, error: 'Prompt is required for JSON output' };
  }
  if (options.stream && !options.prompt) {
    return { valid: false, error: 'Prompt is required for streaming' };
  }
  if (options.autoSession && options.paymentSessionId) {
    return {
      valid: false,
      error: '--auto-session and --payment-session-id are mutually exclusive. Use one or the other.',
    };
  }
  if (options.paymentInstrumentId?.trim() === '') {
    return { valid: false, error: '--payment-instrument-id cannot be empty' };
  }
  if (options.paymentSessionId?.trim() === '') {
    return { valid: false, error: '--payment-session-id cannot be empty' };
  }
  return { valid: true };
}
