import type { Logger } from "../logging";
import type { Middleware } from "../router";
import { LoggerKey, PathKey } from "../router";

interface WithLoggingConfig {
  logger: Logger;
}

/**
 * Middleware that creates a child logger bound to the current command path
 * and logs execution start, success, and failure.
 *
 * @param config - Contains the root {@link Logger} to derive children from.
 */
export function withLogging(config: WithLoggingConfig): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const commandPath = ctx.require(PathKey);
      const logger = config.logger.child({ commandPath });
      try {
        // TODO: ensure sensitive fields are redacted from flags/args.
        logger.child({ flags, args }).debug("executing command");
        await h.handle(ctx.withValue<Logger>(LoggerKey, logger), flags, args);
        logger.debug("command executed successfully");
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger
          .child({ errorName: error.name, errorMessage: error.message, stack: error.stack ?? "" })
          .error("command failed");
        throw err;
      }
    },
  });
}
