import type { Logger } from "../logging";
import type { Flag, Middleware } from "../router";
import { FeatureFlagsKey, LoggerKey, PathKey } from "../router";

interface WithLoggingConfig {
  logger: Logger;
}

const REDACTED = "[REDACTED]";

// replace the values of sensitive flags with a placeholder
function redactSensitiveFlags(
  flags: Record<string, unknown>,
  flagDefs: Flag[],
): Record<string, unknown> {
  const sensitiveNames = new Set(flagDefs.filter((f) => f.sensitive).map((f) => f.name));
  if (sensitiveNames.size === 0) return flags;

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    redacted[key] = sensitiveNames.has(key) && value !== undefined ? REDACTED : value;
  }
  return redacted;
}

/**
 * Middleware that creates a child logger bound to the current command path
 * and logs execution start and success.
 *
 * @param config - Contains the root {@link Logger} to derive children from.
 */
export function withLogging(config: WithLoggingConfig): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const commandPath = ctx.require(PathKey);
      const logger = config.logger.child({ commandPath });
      const safeFlags = redactSensitiveFlags(flags, h.flags());

      logger.child({ flags: safeFlags, args }).debug("executing command");
      // Which experiments were on is the first thing a debug log of a run needs
      // to answer; logged only when something is enabled so the common case
      // adds no noise. Absent (no withFeatureFlags above this point) means none.
      const featureFlags = ctx.value(FeatureFlagsKey)?.enabled() ?? [];
      if (featureFlags.length > 0) {
        logger.child({ featureFlags }).debug("experimental feature flags enabled");
      }
      await h.handle(ctx.withValue<Logger>(LoggerKey, logger), flags, args);
      logger.debug("command executed successfully");
    },
  });
}
