import type { NetworkMode } from '../../../../schema';

export { DEFAULT_PYTHON_VERSION } from '../../../../schema';

/**
 * Default configuration values for create command
 */

/** Default network mode for agent runtimes */
export const DEFAULT_NETWORK_MODE: NetworkMode = 'PUBLIC';

/** Default entrypoint for Python agents */
export const DEFAULT_PYTHON_ENTRYPOINT = 'main.py';

/** Default memory event expiry duration in days */
export const DEFAULT_MEMORY_EXPIRY_DAYS = 30;
