export interface LifecycleOptions {
  idleTimeout?: number | string;
  maxLifetime?: number | string;
}

export interface LifecycleValidationResult {
  valid: boolean;
  error?: string;
}

export const LIFECYCLE_MIN = 60;
export const LIFECYCLE_MAX = 28800;

export function validateLifecycleOptions(options: LifecycleOptions): LifecycleValidationResult {
  if (options.idleTimeout !== undefined) {
    const val = Number(options.idleTimeout);
    if (isNaN(val) || !Number.isInteger(val) || val < LIFECYCLE_MIN || val > LIFECYCLE_MAX) {
      return {
        valid: false,
        error: `--idle-timeout must be an integer between ${LIFECYCLE_MIN} and ${LIFECYCLE_MAX} seconds`,
      };
    }
    options.idleTimeout = val;
  }
  if (options.maxLifetime !== undefined) {
    const val = Number(options.maxLifetime);
    if (isNaN(val) || !Number.isInteger(val) || val < LIFECYCLE_MIN || val > LIFECYCLE_MAX) {
      return {
        valid: false,
        error: `--max-lifetime must be an integer between ${LIFECYCLE_MIN} and ${LIFECYCLE_MAX} seconds`,
      };
    }
    options.maxLifetime = val;
  }
  if (options.idleTimeout !== undefined && options.maxLifetime !== undefined) {
    if (Number(options.idleTimeout) > Number(options.maxLifetime)) {
      return { valid: false, error: '--idle-timeout must be <= --max-lifetime' };
    }
  }
  return { valid: true };
}
