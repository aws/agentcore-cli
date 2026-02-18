import { CodeZipDevServer } from './codezip-dev-server';
import type { DevConfig } from './config';
import { ContainerDevServer } from './container-dev-server';
import type { DevServer, DevServerOptions } from './dev-server';

/**
 * Dev server barrel module.
 * Re-exports types, utilities, and the factory function.
 */
export { findAvailablePort, waitForPort } from './utils';
export { DevServer, type LogLevel, type DevServerCallbacks, type DevServerOptions } from './dev-server';
export { CodeZipDevServer } from './codezip-dev-server';
export { ContainerDevServer } from './container-dev-server';

/**
 * Factory function to create the appropriate dev server based on build type.
 */
export function createDevServer(config: DevConfig, options: DevServerOptions): DevServer {
  return config.buildType === 'Container'
    ? new ContainerDevServer(config, options)
    : new CodeZipDevServer(config, options);
}
