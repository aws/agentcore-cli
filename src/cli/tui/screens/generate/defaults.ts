import type { NetworkMode, PythonRuntime } from '../../../../schema';

/**
 * Default configuration values for create command
 */

/** Default Python runtime version for new agents */
export const DEFAULT_PYTHON_VERSION: PythonRuntime = 'PYTHON_3_13';

/** Default network mode for agent runtimes */
export const DEFAULT_NETWORK_MODE: NetworkMode = 'PUBLIC';

/** Default entrypoint for Python agents */
export const DEFAULT_PYTHON_ENTRYPOINT = 'main.py';

/** Default memory event expiry duration in days */
export const DEFAULT_MEMORY_EXPIRY_DAYS = 30;
