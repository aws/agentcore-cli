import { LIFECYCLE_TIMEOUT_MAX, LIFECYCLE_TIMEOUT_MIN } from '../../../schema';

export interface LifecycleOptions {
  idleTimeout?: number | string;
  maxLifetime?: number | string;
}

export interface LifecycleValidationResult {
  valid: boolean;
  error?: string;
  idleTimeout?: number;
  maxLifetime?: number;
}

/**
 * Parse and validate lifecycle CLI options.
 * Coerces string values to numbers and validates range constraints.
 * Returns the parsed numeric values in the result — does NOT mutate the input.
 */
export function parseAndValidateLifecycleOptions(options: LifecycleOptions): LifecycleValidationResult {
  let idleTimeout: number | undefined;
  let maxLifetime: number | undefined;

  if (options.idleTimeout !== undefined) {
    const val = Number(options.idleTimeout);
    if (isNaN(val) || !Number.isInteger(val) || val < LIFECYCLE_TIMEOUT_MIN || val > LIFECYCLE_TIMEOUT_MAX) {
      return {
        valid: false,
        error: `--idle-timeout must be an integer between ${LIFECYCLE_TIMEOUT_MIN} and ${LIFECYCLE_TIMEOUT_MAX} seconds`,
      };
    }
    idleTimeout = val;
  }
  if (options.maxLifetime !== undefined) {
    const val = Number(options.maxLifetime);
    if (isNaN(val) || !Number.isInteger(val) || val < LIFECYCLE_TIMEOUT_MIN || val > LIFECYCLE_TIMEOUT_MAX) {
      return {
        valid: false,
        error: `--max-lifetime must be an integer between ${LIFECYCLE_TIMEOUT_MIN} and ${LIFECYCLE_TIMEOUT_MAX} seconds`,
      };
    }
    maxLifetime = val;
  }
  if (idleTimeout !== undefined && maxLifetime !== undefined) {
    if (idleTimeout > maxLifetime) {
      return { valid: false, error: '--idle-timeout must be <= --max-lifetime' };
    }
  }
  return { valid: true, idleTimeout, maxLifetime };
}
